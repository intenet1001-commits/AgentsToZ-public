import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET_URL = 'http://localhost:9000/';
const RESULTS_PATH = join(TESTS_DIR, 'results', 'performance-report.json');

function gradeMetric(metric, value) {
  const thresholds = {
    fcp:  { good: 1800, poor: 3000 },
    lcp:  { good: 2500, poor: 4000 },
    cls:  { good: 0.1,  poor: 0.25 },
    ttfb: { good: 800,  poor: 1800 },
    tbt:  { good: 200,  poor: 600 },
    tti:  { good: 3800, poor: 7300 },
  };
  const t = thresholds[metric];
  if (!t || value == null) return 'N/A';
  if (value <= t.good) return 'A';
  if (value <= t.poor) return 'B';
  return 'D';
}

function overallGrade(grades) {
  const vals = grades.filter(g => g !== 'N/A');
  const dCount = vals.filter(g => g === 'D').length;
  const bCount = vals.filter(g => g === 'B').length;
  if (dCount >= 2) return 'D';
  if (dCount === 1) return 'C';
  if (bCount >= 2) return 'B';
  if (bCount === 1) return 'B';
  return 'A';
}

async function measure() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  // Collect network requests
  const networkRequests = [];
  const page = await context.newPage();
  page.on('request', req => {
    networkRequests.push({ url: req.url(), resourceType: req.resourceType() });
  });

  // Navigate and wait for network idle
  const navStart = Date.now();
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
  const navEnd = Date.now();

  // Wait a bit more for LCP/CLS to settle
  await page.waitForTimeout(2000);

  // Screenshot
  await page.screenshot({
    path: join(TESTS_DIR, 'screenshots', 'perf-snapshot.png'),
    fullPage: false
  });

  // Core Web Vitals
  const vitals = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const timing = performance.timing;

    const ttfb = navigation
      ? Math.round(navigation.responseStart - navigation.requestStart)
      : Math.round(timing.responseStart - timing.requestStart);

    const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
    const fcp = fcpEntry ? Math.round(fcpEntry.startTime) : null;

    let lcp = null;
    try {
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      if (lcpEntries.length > 0) lcp = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
    } catch (e) {}

    let cls = 0;
    try {
      performance.getEntriesByType('layout-shift').forEach(e => {
        if (!e.hadRecentInput) cls += e.value;
      });
      cls = Math.round(cls * 1000) / 1000;
    } catch (e) {}

    const domContentLoaded = navigation
      ? Math.round(navigation.domContentLoadedEventEnd - navigation.startTime)
      : Math.round(timing.domContentLoadedEventEnd - timing.navigationStart);

    const domComplete = navigation
      ? Math.round(navigation.domComplete - navigation.startTime)
      : Math.round(timing.domComplete - timing.navigationStart);

    const loadEvent = navigation
      ? Math.round(navigation.loadEventEnd - navigation.startTime)
      : Math.round(timing.loadEventEnd - timing.navigationStart);

    // Long tasks / TBT
    let longTasks = [];
    try {
      longTasks = performance.getEntriesByType('longtask').map(t => ({
        startTime: Math.round(t.startTime),
        duration: Math.round(t.duration)
      }));
    } catch (e) {}

    const tbt = longTasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0);

    // Memory
    let memory = null;
    if (performance.memory) {
      memory = {
        usedJSHeapSizeMB: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
        totalJSHeapSizeMB: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024),
        jsHeapSizeLimitMB: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024)
      };
    }

    return { ttfb, fcp, lcp, cls, domContentLoaded, domComplete, loadEvent, tbt, longTasks, memory };
  });

  // DOM & resource analysis
  const domResources = await page.evaluate(() => {
    const allElements = document.querySelectorAll('*');
    const domSize = allElements.length;
    let maxDepth = 0;
    allElements.forEach(el => {
      let depth = 0, parent = el;
      while (parent.parentElement) { depth++; parent = parent.parentElement; }
      maxDepth = Math.max(maxDepth, depth);
    });

    const resources = performance.getEntriesByType('resource');
    const scripts = resources.filter(r => r.initiatorType === 'script');
    const styles = resources.filter(r => r.initiatorType === 'css' || r.initiatorType === 'link');
    const images = resources.filter(r => r.initiatorType === 'img');
    const fonts = resources.filter(r => r.initiatorType === 'font' || r.name.match(/\.(woff2?|ttf|otf|eot)(\?|$)/));
    const totalTransferSize = resources.reduce((s, r) => s + (r.transferSize || 0), 0);

    const renderBlockingCSS = [...document.querySelectorAll('link[rel="stylesheet"]:not([media="print"])')].filter(
      l => !l.hasAttribute('async') && !l.hasAttribute('defer')
    ).length;
    const blockingScripts = [...document.querySelectorAll('script[src]:not([async]):not([defer]):not([type="module"])')].length;

    // Image optimization check
    const imgEls = [...document.querySelectorAll('img')];
    const unoptimizedImages = imgEls.filter(img => {
      const src = img.src || '';
      const isWebP = src.includes('.webp');
      const hasWidthHeight = img.hasAttribute('width') && img.hasAttribute('height');
      return !isWebP || !hasWidthHeight;
    }).map(img => ({
      src: img.src,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      displayWidth: img.clientWidth,
      displayHeight: img.clientHeight,
      hasWidthAttr: img.hasAttribute('width'),
      hasHeightAttr: img.hasAttribute('height'),
      loading: img.getAttribute('loading'),
      isWebP: img.src.includes('.webp')
    }));

    return {
      dom: { totalElements: domSize, maxDepth, isTooLarge: domSize > 1500, isTooDeep: maxDepth > 32 },
      resources: {
        total: resources.length,
        scripts: { count: scripts.length, totalSizeKB: Math.round(scripts.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024) },
        styles: { count: styles.length, totalSizeKB: Math.round(styles.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024) },
        images: { count: images.length, totalSizeKB: Math.round(images.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024) },
        fonts: { count: fonts.length, totalSizeKB: Math.round(fonts.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024) },
        totalTransferSizeKB: Math.round(totalTransferSize / 1024)
      },
      renderBlocking: { stylesheets: renderBlockingCSS, scripts: blockingScripts, total: renderBlockingCSS + blockingScripts },
      images: { total: imgEls.length, unoptimized: unoptimizedImages }
    };
  });

  await browser.close();

  // TTI approximation: domContentLoaded + some buffer (no Long Tasks API in headless easily)
  const tti = vitals.domContentLoaded ? vitals.domContentLoaded + (vitals.tbt || 0) : null;

  // Count requests by type
  const reqByType = networkRequests.reduce((acc, r) => {
    acc[r.resourceType] = (acc[r.resourceType] || 0) + 1;
    return acc;
  }, {});

  // Known bundle sizes from build output
  const knownBundleJS_KB = 483; // 482.96 kB from build
  const knownBundleCSS_KB = 28; // 27.81 kB from build

  // Grades
  const fcpGrade  = gradeMetric('fcp',  vitals.fcp);
  const lcpGrade  = gradeMetric('lcp',  vitals.lcp);
  const clsGrade  = gradeMetric('cls',  vitals.cls);
  const ttfbGrade = gradeMetric('ttfb', vitals.ttfb);
  const tbtGrade  = gradeMetric('tbt',  vitals.tbt);
  const ttiGrade  = gradeMetric('tti',  tti);
  const grade = overallGrade([fcpGrade, lcpGrade, clsGrade, ttfbGrade, tbtGrade]);

  // Build optimization suggestions
  const issues = [];

  if (vitals.fcp > 1800) {
    issues.push({
      priority: 'high', category: 'fcp',
      issue: `FCP ${vitals.fcp}ms exceeds 1800ms target`,
      recommendation: 'Consider code-splitting, defer non-critical JS, preload critical assets',
      estimatedImpact: 'FCP improvement of 200-500ms'
    });
  }
  if (vitals.lcp > 2500) {
    issues.push({
      priority: 'high', category: 'lcp',
      issue: `LCP ${vitals.lcp}ms exceeds 2500ms target`,
      recommendation: 'Optimize largest element rendering, preload LCP resource, reduce JS blocking time',
      estimatedImpact: 'LCP improvement of 300-800ms'
    });
  }
  if (vitals.cls > 0.1) {
    issues.push({
      priority: 'medium', category: 'cls',
      issue: `CLS ${vitals.cls} exceeds 0.1 target`,
      recommendation: 'Add explicit width/height to images, avoid inserting content above existing content',
      estimatedImpact: 'CLS reduction below 0.1'
    });
  }
  if (knownBundleJS_KB > 300) {
    issues.push({
      priority: 'medium', category: 'bundle-size',
      issue: `JS bundle is ${knownBundleJS_KB}kB — large for a SPA`,
      recommendation: 'Apply dynamic import() for heavy components (PortalManager, build modals), use React.lazy + Suspense',
      estimatedImpact: 'Initial JS load reduced by ~40-60%'
    });
  }
  if (domResources.renderBlocking.total > 0) {
    issues.push({
      priority: 'medium', category: 'render-blocking',
      issue: `${domResources.renderBlocking.total} render-blocking resource(s) detected`,
      recommendation: 'Add async/defer to scripts, use media queries for non-critical CSS',
      estimatedImpact: 'FCP improvement of 100-300ms'
    });
  }
  if (domResources.dom.isTooLarge) {
    issues.push({
      priority: 'low', category: 'dom-size',
      issue: `DOM has ${domResources.dom.totalElements} elements (threshold: 1500)`,
      recommendation: 'Virtualize long port lists with react-window or similar',
      estimatedImpact: 'Reduced memory and layout cost'
    });
  }
  if (domResources.images.unoptimized.length > 0) {
    issues.push({
      priority: 'low', category: 'images',
      issue: `${domResources.images.unoptimized.length} image(s) may lack size attributes or WebP format`,
      recommendation: 'Add explicit width/height attributes and use WebP format where possible',
      estimatedImpact: 'CLS prevention and faster image decode'
    });
  }
  if (vitals.tbt > 200) {
    issues.push({
      priority: 'medium', category: 'tbt',
      issue: `TBT ${vitals.tbt}ms — long tasks blocking main thread`,
      recommendation: 'Break up long synchronous operations, defer non-critical initialization',
      estimatedImpact: 'TTI and TBT improvement of 100-400ms'
    });
  }

  const report = {
    url: TARGET_URL,
    timestamp: new Date().toISOString(),
    summary: {
      overallGrade: grade,
      fcp:  { value: vitals.fcp  != null ? `${vitals.fcp}ms`  : 'N/A', grade: fcpGrade  },
      lcp:  { value: vitals.lcp  != null ? `${vitals.lcp}ms`  : 'N/A', grade: lcpGrade  },
      cls:  { value: vitals.cls  != null ? `${vitals.cls}`     : 'N/A', grade: clsGrade  },
      ttfb: { value: vitals.ttfb != null ? `${vitals.ttfb}ms` : 'N/A', grade: ttfbGrade },
      tbt:  { value: vitals.tbt  != null ? `${vitals.tbt}ms`  : 'N/A', grade: tbtGrade  },
      tti:  { value: tti          != null ? `${tti}ms`          : 'N/A', grade: ttiGrade  },
    },
    pages: [
      {
        url: TARGET_URL,
        metrics: {
          ttfb_ms: vitals.ttfb,
          fcp_ms:  vitals.fcp,
          lcp_ms:  vitals.lcp,
          cls:     vitals.cls,
          tbt_ms:  vitals.tbt,
          tti_ms:  tti,
          domContentLoaded_ms: vitals.domContentLoaded,
          domComplete_ms:      vitals.domComplete,
          loadEvent_ms:        vitals.loadEvent,
        },
        grade,
        dom: domResources.dom,
        resources: {
          ...domResources.resources,
          knownBundleJS_KB,
          knownBundleCSS_KB,
          networkRequestCount: networkRequests.length,
          requestsByType: reqByType,
        },
        renderBlocking: domResources.renderBlocking,
        memory: vitals.memory,
        images: domResources.images,
        longTasks: vitals.longTasks,
      }
    ],
    grade,
    metrics: {
      fcp_ms:  vitals.fcp,
      lcp_ms:  vitals.lcp,
      cls:     vitals.cls,
      ttfb_ms: vitals.ttfb,
      tbt_ms:  vitals.tbt,
      tti_ms:  tti,
    },
    issues,
    screenshotPath: 'tests/screenshots/perf-snapshot.png',
  };

  // Summary sentence
  report.summary_text = `Grade ${grade}. FCP=${vitals.fcp ?? 'N/A'}ms (${fcpGrade}), LCP=${vitals.lcp ?? 'N/A'}ms (${lcpGrade}), CLS=${vitals.cls ?? 'N/A'} (${clsGrade}), TTFB=${vitals.ttfb ?? 'N/A'}ms (${ttfbGrade}), TBT=${vitals.tbt ?? 'N/A'}ms (${tbtGrade}). Bundle: ${knownBundleJS_KB}kB JS + ${knownBundleCSS_KB}kB CSS. ${networkRequests.length} network requests on load. ${issues.length} optimization issue(s) found.`;

  import('fs').then(fs => {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2));
    console.log('Report written to', RESULTS_PATH);
    console.log(report.summary_text);
    console.log('Grade:', grade);
    console.log('Issues:', issues.map(i => `[${i.priority}] ${i.issue}`).join('\n'));
  });
}

measure().catch(err => {
  console.error('Performance measurement failed:', err);
  process.exit(1);
});
