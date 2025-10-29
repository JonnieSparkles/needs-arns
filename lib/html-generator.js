// Tweet replica HTML generator

// ---------- html generation functions ----------
export function generateTweetHTML(mentionTweet, parentTweet, mediaArray = []) {
  const arweaveGateway = 'https://arweave.net';
  
  // Format date
  const tweetDate = new Date(parentTweet.created_at);
  const formattedDate = tweetDate.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric' 
  });

  // Generate media HTML
  const mediaHTML = generateMediaGrid(mediaArray, arweaveGateway);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tweet Archive - @${parentTweet.user_name}</title>
  <meta name="description" content="${escapeHtml(parentTweet.text)}">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #15202b;
      color: #ffffff;
      padding: 20px;
      line-height: 1.5;
    }
    
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #192734;
      border: 1px solid #38444d;
      border-radius: 16px;
      padding: 16px;
    }
    
    .tweet-header {
      display: flex;
      align-items: center;
      margin-bottom: 12px;
      gap: 8px;
    }
    
    .user-info {
      display: flex;
      flex-direction: column;
    }
    
    .username {
      font-weight: 700;
      font-size: 15px;
      color: #ffffff;
    }
    
    .handle {
      font-size: 15px;
      color: #8b98a5;
    }
    
    .date {
      font-size: 15px;
      color: #8b98a5;
      margin-left: auto;
    }
    
    .tweet-text {
      font-size: 16px;
      line-height: 1.5;
      margin-bottom: 12px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    
    .media-grid {
      margin-bottom: 12px;
      border-radius: 16px;
      overflow: hidden;
      display: grid;
      gap: 2px;
      background-color: #000;
    }
    
    .media-grid.single {
      grid-template-columns: 1fr;
    }
    
    .media-grid.double {
      grid-template-columns: repeat(2, 1fr);
    }
    
    .media-grid.triple {
      grid-template-columns: repeat(2, 1fr);
    }
    
    .media-grid.quad {
      grid-template-columns: repeat(2, 1fr);
    }
    
    .media-item {
      position: relative;
      width: 100%;
      background-color: #000;
    }
    
    .media-item.span-full {
      grid-column: 1 / -1;
    }
    
    .media-item img,
    .media-item video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    
    .archive-footer {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid #38444d;
      font-size: 14px;
      color: #8b98a5;
      text-align: center;
    }
    
    .archive-footer a {
      color: #1d9bf0;
      text-decoration: none;
    }
    
    .archive-footer a:hover {
      text-decoration: underline;
    }
    
    .request-info {
      margin-top: 12px;
      padding: 12px;
      background-color: #1c2938;
      border-radius: 8px;
      font-size: 13px;
      color: #8b98a5;
    }
    
    .request-info strong {
      color: #ffffff;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="tweet-header">
      <div class="user-info">
        <span class="username">@${escapeHtml(parentTweet.user_name)}</span>
      </div>
      <span class="date">${formattedDate}</span>
    </div>
    
    <div class="tweet-text">${escapeHtml(parentTweet.text)}</div>
    
    ${mediaHTML}
    
    <div class="archive-footer">
      <div>🏛️ Archived on Arweave via <a href="https://twitter.com/NeedsArNS" target="_blank">@NeedsArNS</a></div>
      <div class="request-info">
        <strong>Requested by:</strong> @${escapeHtml(mentionTweet.user_name)}<br>
        <strong>Archived:</strong> ${new Date(mentionTweet.created_at).toLocaleString('en-US')}
      </div>
    </div>
  </div>
</body>
</html>`;

  return html;
}

function generateMediaGrid(mediaArray, gateway) {
  if (!mediaArray || mediaArray.length === 0) {
    return '';
  }

  const count = mediaArray.length;
  let gridClass = 'single';
  
  if (count === 2) gridClass = 'double';
  else if (count === 3) gridClass = 'triple';
  else if (count >= 4) gridClass = 'quad';

  let mediaItems = '';
  
  mediaArray.slice(0, 4).forEach((media, index) => {
    const spanFull = (count === 3 && index === 0) ? ' span-full' : '';
    
    if (media.type === 'photo' || media.type === 'link') {
      // Treat 'link' type as photo (existing Arweave content)
      mediaItems += `
      <div class="media-item${spanFull}">
        <img src="${gateway}/${media.txId}" alt="${escapeHtml(media.alt_text || 'Image')}">
      </div>`;
    } else if (media.type === 'video' || media.type === 'animated_gif') {
      mediaItems += `
      <div class="media-item${spanFull}">
        <video controls ${media.type === 'animated_gif' ? 'autoplay loop muted' : ''}>
          <source src="${gateway}/${media.txId}" type="video/mp4">
          Your browser does not support the video tag.
        </video>
      </div>`;
    }
  });

  return `<div class="media-grid ${gridClass}">${mediaItems}</div>`;
}

function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

