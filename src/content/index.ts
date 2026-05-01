import { mountContentApp } from './App';
import { shinobuBake } from '../pipeline/bake';

(window as any).__shinobu_bake__ = shinobuBake;

// Bridge for benchmark baking: listen for postMessage from main world
window.addEventListener("message", async (event) => {
  if (event.data?.type !== "__shinobu_bake_request__") return;
  try {
    const result = await shinobuBake(event.data.dataUrl);
    window.postMessage({ type: "__shinobu_bake_response__", result }, "*");
  } catch (e: any) {
    window.postMessage({ type: "__shinobu_bake_response__", error: e.message }, "*");
  }
});
// Signal that the bake bridge is ready
window.postMessage({ type: "__shinobu_bake_ready__" }, "*");

mountContentApp();
