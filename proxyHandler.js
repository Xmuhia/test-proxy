const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const cors = require('@koa/cors');
const URL = require('url').URL;
const axios = require('axios');
const os = require('os');
const logger = require('koa-morgan'); // Koa-compatible morgan logger

const validateUrl = (url) => {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch (error) {
    return false;
  }
};

let browser;

const startBrowser = async () => {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
      ignoreHTTPSErrors: true,
    });

    process.on('exit', async () => {
      if (browser) await browser.close();
    });
  }
  return browser;
};

// Utility function to download assets (JS, CSS, Images)
const downloadAsset = async (assetUrl, baseUrl) => {
  const fileUrl = new URL(assetUrl, baseUrl);
  const filePath = path.join(os.tmpdir(), path.basename(fileUrl.pathname)); // Save in system's temp directory

  // Check if the file exists, if not download it
  if (!fs.existsSync(filePath)) {
    const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
    fs.writeFileSync(filePath, response.data);
  }

  return filePath;
};

// Comprehensive URL rewriting for all URL types
const rewriteUrlsInContent = (content, targetUrl, proxyUrl) => {
  const parsedTarget = new URL(targetUrl);
  const targetOrigin = `${parsedTarget.protocol}//${parsedTarget.host}`;
  
  // Handle absolute URLs (http://example.com/path)
  content = content.replace(/(["'\s])(https?:\/\/[^"'\s]+)/gi, (match, quote, url) => {
    return `${quote}${proxyUrl}?url=${encodeURIComponent(url)}`;
  });
  
  // Handle protocol-relative URLs (//example.com/path)
  content = content.replace(/(["'\s])(\/\/[^"'\s]+)/gi, (match, quote, url) => {
    return `${quote}${proxyUrl}?url=${encodeURIComponent(`${parsedTarget.protocol}${url}`)}`;
  });
  
  // Handle root-relative URLs (/path)
  content = content.replace(/(["'\s])(\/[^"'\s>]+)/gi, (match, quote, path) => {
    return `${quote}${proxyUrl}?url=${encodeURIComponent(`${targetOrigin}${path}`)}`;
  });
  
  return content;
};

// CSS-specific URL rewriting
const rewriteCssUrls = (cssContent, targetUrl, proxyBaseUrl) => {
  const parsedTarget = new URL(targetUrl);
  const targetOrigin = `${parsedTarget.protocol}//${parsedTarget.host}`;
  
  // Match url() patterns in CSS
  return cssContent.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, url) => {
    // Skip data URLs
    if (url.startsWith('data:')) return match;
    
    // Handle different URL types
    let absoluteUrl;
    if (url.startsWith('http')) {
      // Absolute URL
      absoluteUrl = url;
    } else if (url.startsWith('//')) {
      // Protocol-relative URL
      absoluteUrl = `${parsedTarget.protocol}${url}`;
    } else if (url.startsWith('/')) {
      // Root-relative URL
      absoluteUrl = `${targetOrigin}${url}`;
    } else {
      // Path-relative URL - resolve against target URL
      const baseDir = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      absoluteUrl = new URL(url, baseDir).href;
    }
    
    return `url("${proxyBaseUrl}?url=${encodeURIComponent(absoluteUrl)}")`;
  });
};

// JavaScript-specific URL rewriting
const rewriteJsUrls = (jsContent, targetUrl, proxyBaseUrl) => {
  // Basic string replacement for common URL patterns in JavaScript
  const parsedTarget = new URL(targetUrl);
  const targetOrigin = `${parsedTarget.protocol}//${parsedTarget.host}`;
  
  // Replace URL strings in JS 
  jsContent = jsContent.replace(/(["'])(https?:\/\/[^"']+)(["'])/g, (match, quote1, url, quote2) => {
    return `${quote1}${proxyBaseUrl}?url=${encodeURIComponent(url)}${quote2}`;
  });
  
  // Handle protocol-relative URLs
  jsContent = jsContent.replace(/(["'])(\/\/[^"']+)(["'])/g, (match, quote1, url, quote2) => {
    return `${quote1}${proxyBaseUrl}?url=${encodeURIComponent(`${parsedTarget.protocol}${url}`)}${quote2}`;
  });
  
  return jsContent;
};

// Enhanced error handling with retry mechanism
const fetchPageWithRetry = async (url, maxRetries = 3) => {
  let lastError;
  let page;
  const browser = await startBrowser();
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      page = await browser.newPage();
      console.log(`Attempt ${attempt}/${maxRetries} to fetch ${url}`);
      
      // Apply stealth techniques
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'User-Agent': getRandomUserAgent(),
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      });
      
      // Apply any stored cookies
      await applyCookies(page, url);
      
      // Navigate to the page
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      
      // Wait for network to become relatively idle
      await page.waitForLoadState('networkidle', { timeout: 10000 })
        .catch(() => console.log('Timeout waiting for networkidle, continuing anyway'));
      
      // Check if we hit a Cloudflare challenge
      const content = await page.content();
      if (content.includes('cf-browser-verification') || content.includes('cf_chl_prog')) {
        console.log('Cloudflare challenge detected, waiting for resolution...');
        // Wait for challenge to resolve
        await page.waitForTimeout(5000);
        await page.waitForLoadState('networkidle', { timeout: 15000 })
          .catch(() => console.log('Timeout waiting for challenge resolution, continuing anyway'));
      }
      
      // Save cookies for future requests
      await saveCookies(page, url);
      
      return page;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      lastError = error;
      
      if (page) {
        await page.close().catch(() => {});
      }
      
      // Wait before retrying (exponential backoff)
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`Failed to fetch page after ${maxRetries} attempts: ${lastError.message}`);
};

const handler = async (ctx) => {
  if (ctx.method !== 'GET') {
    ctx.status = 405;
    ctx.body = { status: 'error', message: 'Only GET requests are allowed.' };
    return;
  }

  const targetUrl = ctx.query.url;
  if (!targetUrl || !validateUrl(targetUrl)) {
    ctx.status = 400;
    ctx.body = { status: 'error', message: 'Invalid URL.' };
    return;
  }

// Build the proxy base URL dynamically
const protocol = ctx.request.secure ? 'https' : 'http';
const host = ctx.request.host;
const proxyBaseUrl = `${protocol}://${host}`;

  try {
    // ✅ Fix CORS issues
    ctx.set('Access-Control-Allow-Origin', '*');
    ctx.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    ctx.set('Access-Control-Allow-Credentials', 'true');

    // ✅ Remove restrictive security headers
    const securityHeaders = [
      'x-frame-options',
      'content-security-policy',
      'permissions-policy',
      'strict-transport-security',
      'x-content-type-options',
      'feature-policy',
      'referrer-policy',
    ];

    securityHeaders.forEach(header => ctx.set(header, ''));

    // Fetch the page with retry mechanism
    const page = await fetchPageWithRetry(targetUrl);
    
    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
      console.log('Timeout waiting for network idle, continuing anyway');
    });

    // Check content type from response
    const response = page.mainFrame().url() === targetUrl
    ? await page.mainFrame().response()
    : null;

    // Handle redirects
    const finalUrl = page.url();
    if (finalUrl !== targetUrl) {
    console.log(`Redirected from ${targetUrl} to ${finalUrl}`);
    }

    // Get content type
    let contentType = 'text/html';
    if (response) {
    const headers = response.headers();
    contentType = headers['content-type'] || 'text/html';
    }

    // Get content based on content type
let content;
let processedContent;

if (/^image|^audio|^video|^application\/pdf/i.test(contentType)) {
  // Binary content - serve directly via asset handler
  ctx.redirect(`${proxyBaseUrl}/asset?url=${encodeURIComponent(finalUrl)}`);
  await page.close();
  return;
} else {
  // Text content - get and process
  content = await page.content();
  
  // Process content based on type
  if (/html/i.test(contentType)) {
    // HTML - rewrite all URLs
    processedContent = rewriteUrlsInContent(content, finalUrl, `${proxyBaseUrl}/`);
    if (!processedContent.includes('<base')) {
      const baseTag = `<base href="${proxyBaseUrl}/?url=${encodeURIComponent(finalUrl)}">`;
      processedContent = processedContent.replace('<head>', `<head>${baseTag}`);
    }
  } else if (/css/i.test(contentType)) {
    // CSS content
    processedContent = rewriteCssUrls(content, finalUrl, `${proxyBaseUrl}/asset`);
  } else if (/javascript/i.test(contentType)) {
    // JavaScript content
    processedContent = rewriteJsUrls(content, finalUrl, `${proxyBaseUrl}/asset`);
  } else {
    // Other text content
    processedContent = content;
  }
}

    await page.close();
    ctx.body = content;
    ctx.status = 200;
  } catch (error) {
    console.error('❌ Error fetching page:', error);
    ctx.status = 500;
    ctx.body = { status: 'error', message: 'Failed to load page through proxy', details: error.message };
  }
};

module.exports.register = (router) => {
  router.get('/', cors(), handler);
};
