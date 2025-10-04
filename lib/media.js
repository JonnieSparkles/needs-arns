// Media processing utilities

import { downloadMedia, downloadBuffer } from './arweave.js';
import { ARWEAVE_TXID_RE } from './utils.js';

// ---------- media functions ----------
export function hasMediaAttachments(tweetData) {
  return tweetData.attachments?.media_keys?.length > 0;
}

export function extractTxIdFromTweetData(tweetData) {
  const text = tweetData?.text ?? '';
  const urls = tweetData?.entities?.urls ?? [];
  const expanded = urls.map(u => u.expanded_url || u.url).join(' ');
  const haystack = `${text}\n${expanded}`;
  const m = haystack.match(ARWEAVE_TXID_RE);
  return m ? m[1] : null;
}

export async function getMediaUrls(tweetData, includes) {
  if (!hasMediaAttachments(tweetData)) return [];
  
  const mediaKeys = tweetData.attachments.media_keys;
  const mediaObjects = includes?.media || [];
  
  // Process each media item asynchronously
  const results = await Promise.all(mediaKeys.map(async (key) => {
    const mediaObj = mediaObjects.find(m => m.media_key === key);
    if (!mediaObj) {
      return null;
    }
    
    console.log(`🔍 Processing media: type=${mediaObj.type}, hasUrl=${!!mediaObj.url}, hasPreview=${!!mediaObj.preview_image_url}, hasVariants=${!!mediaObj.variants}`);
    
    // For videos and animated GIFs, try to get the highest quality variant
    let bestUrl = mediaObj.url || mediaObj.preview_image_url;
    
    if (mediaObj.type === 'video' && mediaObj.variants) {
      // Find the highest bitrate video variant
      const videoVariants = mediaObj.variants.filter(v => v.content_type?.startsWith('video/'));
      if (videoVariants.length > 0) {
        const bestVariant = videoVariants.reduce((best, current) => {
          const currentBitrate = current.bit_rate || 0;
          const bestBitrate = best.bit_rate || 0;
          return currentBitrate > bestBitrate ? current : best;
        });
        bestUrl = bestVariant.url;
        console.log(`📹 Selected video variant: ${bestVariant.content_type}, bitrate: ${bestVariant.bit_rate}`);
      }
    }
    
    // For animated GIFs, try to get the original URL if available
    // Twitter sometimes serves animated GIFs as 'photo' type but with a direct URL
    if (mediaObj.type === 'photo' && mediaObj.url && !mediaObj.url.includes('pbs.twimg.com/media/')) {
      // This might be a direct link to an animated GIF
      console.log(`🖼️ Photo with direct URL: ${mediaObj.url}`);
    }
    
    // Handle Twitter video thumbnails - try to get the actual GIF/MP4
    if (bestUrl && bestUrl.includes('tweet_video_thumb')) {
      console.log(`🎬 Detected video thumbnail, attempting to get original...`);
      
      // Extract the media ID from the thumbnail URL
      // Format: https://pbs.twimg.com/tweet_video_thumb/MEDIA_ID.jpg
      const thumbMatch = bestUrl.match(/tweet_video_thumb\/([^\/]+)\.jpg/);
      if (thumbMatch) {
        const mediaId = thumbMatch[1];
        
        // Try different possible URLs for the original media
        const possibleUrls = [
          `https://video.twimg.com/tweet_video/${mediaId}.mp4`,
          `https://pbs.twimg.com/tweet_video/${mediaId}.mp4`,
          `https://video.twimg.com/tweet_video/${mediaId}.gif`,
          `https://pbs.twimg.com/tweet_video/${mediaId}.gif`,
          `https://pbs.twimg.com/media/${mediaId}.mp4`,
          `https://pbs.twimg.com/media/${mediaId}.gif`
        ];
        
        console.log(`🔍 Trying to find original media for ID: ${mediaId}`);
        
        let foundOriginal = false;
        // Try each URL to see which one works
        for (const testUrl of possibleUrls) {
          try {
            const testResponse = await fetch(testUrl, { method: 'HEAD' });
            if (testResponse.ok) {
              console.log(`✅ Found original media: ${testUrl}`);
              bestUrl = testUrl;
              foundOriginal = true;
              break;
            }
          } catch (e) {
            // Continue to next URL
          }
        }
        
        // If we couldn't find the original, return null (no media)
        if (!foundOriginal) {
          console.log(`❌ Could not find original media for animated GIF, skipping...`);
          return null;
        }
      }
    }
    
    console.log(`✅ Final media URL: ${bestUrl}`);
    
    // Return the best URL available
    return {
      url: bestUrl,
      type: mediaObj.type,
      width: mediaObj.width,
      height: mediaObj.height,
      media_key: key
    };
  }));
  
  return results.filter(Boolean);
}

export async function processMediaFromTweet(tweetData, includes, uploadToArweave) {
  const mediaUrls = await getMediaUrls(tweetData, includes);
  
  if (mediaUrls.length === 0) {
    return { success: false, error: 'no_media' };
  }
  
  // Use the first media attachment
  const media = mediaUrls[0];
  console.log(`📸 Processing ${media.type} media: ${media.url}`);
  
  try {
    // Download and upload media
    const mediaBuffer = await downloadMedia(media.url);
    const contentType = media.type === 'photo' ? 'image/jpeg' : 
                       media.type === 'video' || media.type === 'animated_gif' ? 'video/mp4' : 
                       'application/octet-stream';
    
    const txId = await uploadToArweave(mediaBuffer, contentType);
    console.log(`✅ Media uploaded to Arweave: ${txId}`);
    
    return { success: true, txId, isUploadedMedia: true };
  } catch (uploadError) {
    console.error(`❌ Failed to upload media:`, uploadError);
    return { success: false, error: 'upload_failed', message: uploadError.message };
  }
}
