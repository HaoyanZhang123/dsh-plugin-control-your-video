/**
 * Host half entry declared by `package.json` → `main`.
 *
 * The implementation lives in `ui/host/index.js` (CT-00 maps PRODUCT-UI to `产品实现/ui/`);
 * this file is the stable entry the package manifest points at, so a future move inside `ui/`
 * does not change the published entry path.
 *
 * @module ui/plugin/host
 */

export { name, inject, default } from '../host/index.js'
