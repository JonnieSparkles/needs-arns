// Arweave manifest generator

// ---------- manifest functions ----------
export function generateManifest(metadataTxId, mediaArray = [], htmlTxId = null) {
  const manifest = {
    "manifest": "arweave/paths",
    "version": "0.2.0",
    "index": {
      "path": "index.html"
    },
    "paths": {
      "index.html": {
        "id": htmlTxId
      },
      "metadata.json": {
        "id": metadataTxId
      }
    }
  };

  // Add media files to paths
  mediaArray.forEach((media, index) => {
    if (media.txId) {
      // Determine file extension based on type
      const extension = getMediaExtension(media.type);
      const path = `media/${index}.${extension}`;
      manifest.paths[path] = {
        "id": media.txId
      };
    }
  });

  return manifest;
}

function getMediaExtension(mediaType) {
  switch (mediaType) {
    case 'photo':
      return 'jpg';
    case 'video':
      return 'mp4';
    case 'animated_gif':
      return 'mp4';
    case 'link':
      return 'jpg'; // Treat link as image for manifest purposes
    default:
      return 'bin';
  }
}

