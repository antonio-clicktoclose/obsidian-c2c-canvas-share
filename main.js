// C2C Canvas Share: publishes a canvas to the c2c-canvas-share service as a read-only page.
// Plain JavaScript on purpose, so the plugin needs no build step.
const { Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } = require("obsidian");

const DEFAULTS = {
  serverUrl: "https://c2c-canvas-share.vercel.app",
  uploadKey: "",
  shares: {}, // canvas path -> share id
};

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2600;

function newShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

async function sha1Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-1", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

// Local images referenced in markdown: ![[file.png]] and ![alt](file.png).
function embeddedImages(text) {
  const wiki = [...text.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1]);
  const markdown = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((src) => !/^(https?:|data:)/.test(src))
    .map((src) => decodeURIComponent(src));
  return [...wiki, ...markdown];
}

// Large photos are re-encoded so each upload stays under the server's request limit.
async function shrinkIfLarge(buffer, ext) {
  if (ext === "svg" || ext === "gif" || buffer.byteLength <= MAX_IMAGE_BYTES) return { buffer, ext };
  const bitmap = await createImageBitmap(new Blob([buffer]));
  const ratio = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * ratio);
  canvas.height = Math.round(bitmap.height * ratio);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.88));
  return { buffer: await blob.arrayBuffer(), ext: "webp" };
}

module.exports = class CanvasSharePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addSettingTab(new CanvasShareSettings(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "canvas") return;
        menu.addItem((item) =>
          item.setTitle("Share canvas on the web").setIcon("globe").onClick(() => this.share(file))
        );
        if (this.settings.shares[file.path]) {
          menu.addItem((item) =>
            item.setTitle("Copy canvas share link").setIcon("link").onClick(() => this.copyLink(file))
          );
          menu.addItem((item) =>
            item.setTitle("Stop sharing canvas").setIcon("trash").onClick(() => this.unshare(file))
          );
        }
      })
    );

    // Keep share links attached to a canvas when it is renamed or moved.
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        const id = this.settings.shares[oldPath];
        if (!id) return;
        delete this.settings.shares[oldPath];
        this.settings.shares[file.path] = id;
        await this.saveData(this.settings);
      })
    );

    this.addCommand({
      id: "share-current-canvas",
      name: "Share current canvas on the web",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "canvas") return false;
        if (!checking) this.share(file);
        return true;
      },
    });
  }

  linkFor(id) {
    return `${this.settings.serverUrl.replace(/\/$/, "")}/c/${id}`;
  }

  async api(method, path, body, contentType) {
    const res = await requestUrl({
      url: this.settings.serverUrl.replace(/\/$/, "") + path,
      method,
      body,
      contentType,
      headers: { Authorization: `Bearer ${this.settings.uploadKey}` },
      throw: false,
    });
    if (res.status === 401) throw new Error("The upload key is missing or wrong. Check Settings → C2C Canvas Share.");
    if (res.status >= 400) throw new Error(`Server error ${res.status}`);
    return res.json;
  }

  resolveFile(linkpath, sourcePath) {
    const direct = this.app.vault.getAbstractFileByPath(linkpath);
    if (direct instanceof TFile) return direct;
    return this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  }

  async uploadImage(shareId, file) {
    const original = await this.app.vault.readBinary(file);
    const { buffer, ext } = await shrinkIfLarge(original, file.extension.toLowerCase());
    if (buffer.byteLength > 4 * 1024 * 1024) return null;
    const key = `${await sha1Hex(buffer)}.${ext}`;
    const result = await this.api("POST", `/api/asset?id=${shareId}&key=${key}`, buffer, "application/octet-stream");
    return result.url;
  }

  async share(file) {
    if (!this.settings.uploadKey) {
      new Notice("C2C Canvas Share: add the upload key first in Settings → C2C Canvas Share.", 8000);
      return;
    }
    const status = new Notice("C2C Canvas Share: preparing canvas…", 0);
    try {
      const canvas = JSON.parse(await this.app.vault.read(file));
      const shareId = this.settings.shares[file.path] || newShareId();
      const files = {};
      const assets = {};
      const skipped = [];

      const addImage = async (target, sourcePath) => {
        const image = this.resolveFile(target, sourcePath);
        if (!image || assets[target] || !IMAGE_EXT.includes(image.extension.toLowerCase())) return;
        const url = await this.uploadImage(shareId, image);
        if (url) assets[target] = url;
        else skipped.push(image.name);
      };

      // Images placed inside text cards.
      const textImages = (canvas.nodes || [])
        .filter((n) => n.type === "text" && n.text)
        .flatMap((n) => embeddedImages(n.text));
      let done = 0;
      for (const target of textImages) {
        status.setMessage(`C2C Canvas Share: uploading image ${++done} of ${textImages.length}…`);
        await addImage(target, file.path);
      }

      const fileNodes = (canvas.nodes || []).filter((n) => n.type === "file" && n.file);
      done = 0;
      for (const node of fileNodes) {
        status.setMessage(`C2C Canvas Share: uploading ${++done} of ${fileNodes.length}…`);
        const target = this.resolveFile(node.file, file.path);
        if (!target) { skipped.push(node.file); continue; }
        const ext = target.extension.toLowerCase();
        if (IMAGE_EXT.includes(ext)) {
          await addImage(node.file, file.path);
        } else if (ext === "md") {
          const text = stripFrontmatter(await this.app.vault.read(target));
          files[node.file] = text;
          // Images embedded inside the note travel with it.
          for (const image of embeddedImages(text)) {
            await addImage(image, target.path);
          }
        } else {
          skipped.push(target.name);
        }
      }

      status.setMessage("C2C Canvas Share: publishing…");
      const bundle = { id: shareId, title: file.basename, canvas, files, assets };
      const result = await this.api("POST", "/api/share", JSON.stringify(bundle), "application/json");
      this.settings.shares[file.path] = result.id;
      await this.saveData(this.settings);

      const copied = await this.writeClipboard(result.url);
      status.hide();
      const fragment = createFragment((f) => {
        f.appendText(copied ? "✔ Canvas shared. Link copied. " : "✔ Canvas shared. ");
        f.createEl("a", { text: "Open link", href: result.url });
        if (skipped.length) f.appendText(` Not included: ${skipped.join(", ")}.`);
      });
      new Notice(fragment, 12000);
    } catch (error) {
      status.hide();
      console.error("[C2C Canvas Share]", error);
      new Notice(`C2C Canvas Share failed: ${error.message}`, 10000);
    }
  }

  async writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async copyLink(file) {
    const url = this.linkFor(this.settings.shares[file.path]);
    const copied = await this.writeClipboard(url);
    new Notice(copied ? `Link copied: ${url}` : url, 8000);
  }

  async unshare(file) {
    const id = this.settings.shares[file.path];
    try {
      await this.api("DELETE", `/api/share?id=${id}`);
      delete this.settings.shares[file.path];
      await this.saveData(this.settings);
      new Notice("C2C Canvas Share: canvas is no longer shared. The old link now shows nothing.", 8000);
    } catch (error) {
      new Notice(`C2C Canvas Share: could not stop sharing: ${error.message}`, 10000);
    }
  }
};

class CanvasShareSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Upload key")
      .setDesc("From 1Password: C2C Canvas Share upload key (c2c-monorepo vault). Needed once.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.uploadKey).onChange(async (value) => {
          this.plugin.settings.uploadKey = value.trim();
          await this.plugin.saveData(this.plugin.settings);
        });
      });
    new Setting(containerEl)
      .setName("Server")
      .setDesc("Where shared canvases are published.")
      .addText((text) =>
        text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim() || DEFAULTS.serverUrl;
          await this.plugin.saveData(this.plugin.settings);
        })
      );
    const count = Object.keys(this.plugin.settings.shares).length;
    containerEl.createEl("p", { text: `${count} canvas${count === 1 ? "" : "es"} currently shared from this vault.` });
  }
}
