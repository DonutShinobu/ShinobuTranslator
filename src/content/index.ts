import { shinobuBake, shinobuRender } from '../pipeline/bake';
import { twitterAdapter } from './adapters/twitter';
import { pixivAdapter } from './adapters/pixiv';
import { TranslatorCore } from './core/TranslatorCore';

(window as any).__shinobu_bake__ = shinobuBake;

// Bridge for benchmark baking: listen for postMessage from main world
window.addEventListener("message", async (event) => {
  if (event.data?.type === "__shinobu_bake_request__") {
    try {
      const result = await shinobuBake(event.data.dataUrl);
      window.postMessage({ type: "__shinobu_bake_response__", result }, "*");
    } catch (e: any) {
      window.postMessage({ type: "__shinobu_bake_response__", error: e.message }, "*");
    }
  } else if (event.data?.type === "__shinobu_render_request__") {
    try {
      const result = await shinobuRender(event.data.dataUrl);
      window.postMessage({ type: "__shinobu_render_response__", result }, "*");
    } catch (e: any) {
      window.postMessage({ type: "__shinobu_render_response__", error: e.message }, "*");
    }
  }
});
// Signal that the bake bridge is ready
window.postMessage({ type: "__shinobu_bake_ready__" }, "*");

const adapters = [twitterAdapter, pixivAdapter];
const adapter = adapters.find(a => a.match());
if (adapter) {
  const core = new TranslatorCore(adapter);
  core.start();
}
