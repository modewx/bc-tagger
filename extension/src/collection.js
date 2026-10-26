// The extension's bundled "See Collection" page: the shared collection page
// on top of chrome.storage (via the background script).
import { createCollectionPage } from "../../shared/collection/collectionPage";
import { ExtensionDataSource } from "../../shared/datasource/ExtensionDataSource";

console.log("----- collection.js");

createCollectionPage({
  dataSource: new ExtensionDataSource(),
  colWidthKey: "bc_collection_col_widths_v3",
}).start();
