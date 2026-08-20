/**
 * Touch Interaction Validator
 * Tests portmanagement app at 375x812 (mobile viewport)
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'node:url';

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'results');
const URL = 'http://localhost:9000/';

async function run() {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();

  const issues = [];
  const passedChecks = [];

  // ── 1. Navigate ────────────────────────────────────────────────────
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);

  // Screenshot — initial mobile view
  await page.screenshot({
    path: join(RESULTS_DIR, 'touch-mobile-375.png'),
    fullPage: false,
  });

  // ── 2. Viewport meta ───────────────────────────────────────────────
  const viewportMeta = await page.$eval(
    'meta[name="viewport"]',
    (el) => el.getAttribute('content')
  ).catch(() => null);

  if (viewportMeta && viewportMeta.includes('width=device-width')) {
    passedChecks.push('viewport meta: width=device-width present');
  } else {
    issues.push({
      severity: 'high',
      description: `viewport meta tag missing or incorrect: "${viewportMeta}"`,
      recommendation: '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    });
  }

  // ── 3. Touch event handlers ────────────────────────────────────────
  const touchHandlers = await page.evaluate(() => {
    const results = [];
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const keys = Object.keys(el).filter(
        (k) => k.startsWith('__reactFiber') || k.startsWith('__reactProps')
      );
      for (const key of keys) {
        try {
          const props = el[key];
          if (props && typeof props === 'object') {
            const p = props.memoizedProps || props;
            if (p && (p.onTouchStart || p.onTouchEnd || p.onTouchMove)) {
              results.push({
                tag: el.tagName,
                className: el.className?.toString().slice(0, 60),
                hasOnTouchStart: !!p.onTouchStart,
                hasOnTouchEnd: !!p.onTouchEnd,
                touchAction: el.style?.touchAction || window.getComputedStyle(el).touchAction,
              });
            }
          }
        } catch (_) {}
      }
    }
    return results;
  });

  if (touchHandlers.length === 0) {
    passedChecks.push('No touch event handlers found (desktop-first app — expected)');
  } else {
    for (const h of touchHandlers) {
      const ta = h.touchAction;
      if (!ta || ta === 'auto') {
        issues.push({
          severity: 'high',
          description: `Element <${h.tag}> has onTouchStart/onTouchEnd but touch-action is "${ta || 'auto'}" — browser may intercept swipe gestures`,
          recommendation: "Add style={{ touchAction: 'pan-y' }} to the swipe container",
        });
      } else {
        passedChecks.push(`touch-action correctly set to "${ta}" on <${h.tag}>`);
      }
    }
  }

  // ── 4. 100vh vs 100dvh ─────────────────────────────────────────────
  const vhUsage = await page.evaluate(() => {
    const results = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule.cssText && rule.cssText.includes('100vh')) {
            results.push(rule.selectorText || rule.cssText.slice(0, 80));
          }
        }
      } catch (_) {}
    }
    // Also check inline styles
    const inlineVh = [...document.querySelectorAll('[style]')]
      .filter((el) => el.style.height === '100vh' || el.style.minHeight === '100vh')
      .map((el) => ({ tag: el.tagName, class: el.className?.toString().slice(0, 40) }));
    return { cssRules: results, inlineStyles: inlineVh };
  });

  if (vhUsage.cssRules.length > 0 || vhUsage.inlineStyles.length > 0) {
    issues.push({
      severity: 'medium',
      description: `100vh used in ${vhUsage.cssRules.length} CSS rule(s) — on iOS Safari this includes the address bar height, causing content to be obscured`,
      recommendation: 'Replace 100vh with 100dvh (dynamic viewport height)',
      detail: vhUsage.cssRules.slice(0, 3),
    });
  } else {
    passedChecks.push('No 100vh usage detected (100dvh or other units used)');
  }

  // ── 5. Horizontal overflow ─────────────────────────────────────────
  const overflowX = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const viewportWidth = window.innerWidth;
    const offenders = [];
    if (docWidth > viewportWidth) {
      for (const el of document.querySelectorAll('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.right > viewportWidth + 5) {
          offenders.push({
            tag: el.tagName,
            className: el.className?.toString().slice(0, 60),
            right: Math.round(rect.right),
            viewportWidth,
          });
          if (offenders.length >= 5) break;
        }
      }
    }
    return { docWidth, viewportWidth, offenders };
  });

  if (overflowX.offenders.length > 0) {
    issues.push({
      severity: 'high',
      description: `Horizontal overflow detected at 375px viewport. Page width: ${overflowX.docWidth}px > viewport: ${overflowX.viewportWidth}px. ${overflowX.offenders.length} offending element(s).`,
      recommendation: 'Add overflow-x: hidden to body or fix wide elements',
      offenders: overflowX.offenders,
    });
  } else {
    passedChecks.push(`No horizontal overflow at 375px (page width: ${overflowX.docWidth}px)`);
  }

  // ── 6. Touch target sizes ──────────────────────────────────────────
  const smallTargets = await page.evaluate(() => {
    const MIN = 44;
    const results = [];
    const interactive = document.querySelectorAll('button, a, input, select, [role="button"], [tabindex]');
    for (const el of interactive) {
      const rect = el.getBoundingClientRect();
      // Skip invisible elements
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.width < MIN || rect.height < MIN) {
        results.push({
          tag: el.tagName,
          text: (el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim().slice(0, 30),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
        if (results.length >= 10) break;
      }
    }
    return results;
  });

  if (smallTargets.length > 0) {
    issues.push({
      severity: 'medium',
      description: `${smallTargets.length} interactive element(s) smaller than 44×44px minimum touch target size`,
      recommendation: 'Increase button padding or add min-height: 44px for mobile',
      examples: smallTargets.slice(0, 5),
    });
  } else {
    passedChecks.push('All visible interactive elements meet 44×44px touch target minimum');
  }

  // ── 7. Layout integrity at 375px ──────────────────────────────────
  const layoutCheck = await page.evaluate(() => {
    const body = document.body;
    const root = document.getElementById('root');
    return {
      bodyScrollWidth: body.scrollWidth,
      rootScrollWidth: root ? root.scrollWidth : null,
      viewportWidth: window.innerWidth,
      hasFixedElements: [...document.querySelectorAll('*')].filter(
        (el) => window.getComputedStyle(el).position === 'fixed'
      ).length,
    };
  });

  if (layoutCheck.bodyScrollWidth <= 375 + 5) {
    passedChecks.push(`Layout intact at 375px (body scrollWidth: ${layoutCheck.bodyScrollWidth}px)`);
  } else {
    issues.push({
      severity: 'high',
      description: `Body scrollWidth ${layoutCheck.bodyScrollWidth}px exceeds 375px viewport — layout breaks on mobile`,
      recommendation: 'Review fixed-width containers and ensure responsive design',
    });
  }

  // ── 8. Drag-and-drop support check ────────────────────────────────
  const dragSupport = await page.evaluate(() => {
    const draggables = [...document.querySelectorAll('[draggable="true"]')];
    const dropZones = [...document.querySelectorAll('[ondrop], [ondragover]')];
    // Check React props for onDrop/onDragOver
    const reactDrag = [];
    for (const el of document.querySelectorAll('*')) {
      const keys = Object.keys(el).filter((k) => k.startsWith('__reactProps'));
      for (const key of keys) {
        try {
          const p = el[key];
          if (p && (p.onDrop || p.onDragOver || p.onDragStart)) {
            reactDrag.push({ tag: el.tagName, class: el.className?.toString().slice(0, 40) });
          }
        } catch (_) {}
      }
    }
    return { draggables: draggables.length, dropZones: dropZones.length, reactDrag };
  });

  if (dragSupport.draggables > 0 || dragSupport.reactDrag.length > 0) {
    issues.push({
      severity: 'low',
      description: `Drag-and-drop detected (${dragSupport.draggables} draggable elements, ${dragSupport.reactDrag.length} React drag handlers) — touch drag is not natively supported without a dedicated touch-drag library`,
      recommendation: 'Implement touch equivalents using onTouchStart/onTouchMove/onTouchEnd or use a library like @dnd-kit/core with touch sensor support',
    });
  } else {
    passedChecks.push('No drag-and-drop detected (no touch-drag compatibility issue)');
  }

  // ── 9. Screenshot — full page mobile ──────────────────────────────
  await page.screenshot({
    path: join(RESULTS_DIR, 'touch-mobile-375-fullpage.png'),
    fullPage: true,
  });

  await browser.close();

  // ── Grade ──────────────────────────────────────────────────────────
  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const highCount = issues.filter((i) => i.severity === 'high').length;
  const mediumCount = issues.filter((i) => i.severity === 'medium').length;

  let grade;
  if (criticalCount > 0 || highCount >= 3) grade = 'F';
  else if (highCount === 2) grade = 'D';
  else if (highCount === 1) grade = 'C';
  else if (mediumCount >= 2) grade = 'B';
  else if (mediumCount === 1) grade = 'B';
  else grade = 'A';

  const report = {
    timestamp: new Date().toISOString(),
    grade,
    url: URL,
    viewport: '375x812 (iPhone SE/13 mini)',
    summary: {
      touchHandlersFound: touchHandlers.length,
      touchActionConfigured: touchHandlers.filter(
        (h) => h.touchAction && h.touchAction !== 'auto'
      ).length,
      viewportMetaCorrect: !issues.find((i) => i.description.includes('viewport meta')),
      dvhUsage: vhUsage.cssRules.length > 0 ? 'vh' : 'none',
      horizontalOverflow: overflowX.offenders.length > 0,
      smallTouchTargets: smallTargets.length,
      dragDropPresent: dragSupport.draggables > 0 || dragSupport.reactDrag.length > 0,
    },
    issues,
    passedChecks,
    issueCount: { critical: criticalCount, high: highCount, medium: mediumCount, low: issues.filter((i) => i.severity === 'low').length },
  };

  const outPath = join(RESULTS_DIR, 'touch-report.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('Report written to:', outPath);
  console.log('Grade:', grade);
  console.log('Issues:', issues.length, '| Passed:', passedChecks.length);

  return report;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
