// NEO Hand Control - loads the bundled MediaPipe Tasks Vision ESM and exposes
// it as window.NeoHandControl.vision so the classic-script modules can use it.
import * as vision from 'mediapipe-hand://app/vision_bundle.mjs';

window.NeoHandControl = window.NeoHandControl || {};
window.NeoHandControl.vision = vision;
if (typeof window.dispatchEvent === 'function') {
  window.dispatchEvent(new Event('neo-vision-ready'));
}