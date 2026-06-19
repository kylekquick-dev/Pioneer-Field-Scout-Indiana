/* =====================================================================
   Field Scout — Offline queue + thumbnail generation
   Exposes window.FS_OFFLINE with:
     • makeThumbnail(file, max)      -> Blob (downscaled JPEG)
     • downscaleMain(file, max)      -> Blob (capped full-size JPEG)
     • queueAdd(record)              -> save a pending observation in IndexedDB
     • queueAll()                    -> list pending observations
     • queueRemove(localId)          -> drop one after successful sync
     • queueCount()                  -> number pending
   Photos are stored as Blobs inside the queued record so captures survive
   a page reload / app restart while offline.
   ===================================================================== */
(function () {
  const DB_NAME = "fieldscout-offline";
  const STORE = "pending_observations";
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "localId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const out = fn(store);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  }

  async function queueAdd(record) {
    record.localId = "local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    record.queuedAt = Date.now();
    await tx("readwrite", (s) => s.put(record));
    return record.localId;
  }
  function queueAll() {
    return tx("readonly", (s) => {
      return new Promise((resolve) => {
        const r = s.getAll();
        r.onsuccess = () => resolve(r.result || []);
      });
    });
  }
  async function queueRemove(localId) {
    return tx("readwrite", (s) => s.delete(localId));
  }
  async function queueCount() {
    const all = await queueAll();
    return all.length;
  }

  // ---- Image processing (canvas) -----------------------------------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  async function resizeToBlob(file, maxEdge, quality) {
    try {
      const img = await loadImage(file);
      let { width, height } = img;
      if (Math.max(width, height) > maxEdge) {
        const scale = maxEdge / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(img.src);
      return await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b || file), "image/jpeg", quality)
      );
    } catch (e) {
      return file; // fall back to original on any failure
    }
  }

  // 320px thumbnail for cards/galleries; 1600px capped "main" to save storage.
  const makeThumbnail = (file) => resizeToBlob(file, 320, 0.7);
  const downscaleMain = (file) => resizeToBlob(file, 1600, 0.82);

  window.FS_OFFLINE = {
    makeThumbnail,
    downscaleMain,
    queueAdd,
    queueAll,
    queueRemove,
    queueCount,
  };
})();
