import { bootstrapPrototypeApp } from "./app/bootstrap.js";

async function main() {
  try {
    const application = bootstrapPrototypeApp(document);
    const bootResult = await application.readyPromise;
    if (!bootResult.ok) {
      document.documentElement.dataset.moduleBoot = "blocked";
      document.dispatchEvent(new CustomEvent("app:boot-blocked", { detail: bootResult.projection }));
      return;
    }

    document.documentElement.dataset.moduleBoot = "ready";
    document.dispatchEvent(new CustomEvent("prototype:module-ready"));
    document.dispatchEvent(new CustomEvent("app:boot-ready", { detail: bootResult.projection }));
    await application.qaPromise;
  } catch (error) {
    document.documentElement.dataset.moduleBoot = "failed";
    console.error("애플리케이션 module boot에 실패했습니다.", error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main, { once: true });
} else {
  void main();
}
