"""
Touch Interaction Validator
Tests portmanagement app at 375x812 (mobile viewport)
"""
import json
import os
from datetime import datetime
from playwright.sync_api import sync_playwright

RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
URL = "http://localhost:9000/"


def run():
    os.makedirs(RESULTS_DIR, exist_ok=True)
    issues = []
    passed_checks = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 375, "height": 812},
            user_agent=(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
            ),
            has_touch=True,
            is_mobile=True,
        )
        page = context.new_page()

        # 1. Navigate
        page.goto(URL, wait_until="networkidle", timeout=15000)
        page.wait_for_timeout(1500)

        page.screenshot(path=os.path.join(RESULTS_DIR, "touch-mobile-375.png"), full_page=False)

        # 2. Viewport meta
        viewport_content = page.eval_on_selector(
            'meta[name="viewport"]',
            'el => el.getAttribute("content")'
        ) if page.query_selector('meta[name="viewport"]') else None

        if viewport_content and "width=device-width" in viewport_content:
            passed_checks.append(f"viewport meta correct: {viewport_content}")
        else:
            issues.append({
                "severity": "high",
                "description": f'viewport meta tag missing or incorrect: "{viewport_content}"',
                "recommendation": '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            })

        # 3. Touch event handlers via React fiber
        touch_handlers = page.evaluate("""() => {
            const results = [];
            for (const el of document.querySelectorAll('*')) {
                const keys = Object.keys(el).filter(k => k.startsWith('__reactProps'));
                for (const key of keys) {
                    try {
                        const p = el[key];
                        if (p && (p.onTouchStart || p.onTouchEnd || p.onTouchMove)) {
                            results.push({
                                tag: el.tagName,
                                className: (el.className || '').toString().slice(0, 60),
                                hasOnTouchStart: !!p.onTouchStart,
                                hasOnTouchEnd: !!p.onTouchEnd,
                                touchAction: el.style.touchAction || window.getComputedStyle(el).touchAction
                            });
                        }
                    } catch(e) {}
                }
            }
            return results;
        }""")

        if not touch_handlers:
            passed_checks.append("No touch event handlers found (desktop-first app — expected)")
        else:
            for h in touch_handlers:
                ta = h.get("touchAction", "")
                if not ta or ta == "auto":
                    issues.append({
                        "severity": "high",
                        "description": f'<{h["tag"]}> has onTouchStart/onTouchEnd but touch-action is "{ta or "auto"}" — browser may intercept swipe gestures',
                        "recommendation": "Add style={{ touchAction: 'pan-y' }} to the swipe container",
                    })
                else:
                    passed_checks.append(f'touch-action "{ta}" set on <{h["tag"]}>')

        # 4. 100vh vs 100dvh
        vh_usage = page.evaluate("""() => {
            const cssRules = [];
            for (const sheet of document.styleSheets) {
                try {
                    for (const rule of sheet.cssRules || []) {
                        if (rule.cssText && rule.cssText.includes('100vh')) {
                            cssRules.push((rule.selectorText || rule.cssText).slice(0, 80));
                        }
                    }
                } catch(e) {}
            }
            const inlineStyles = [...document.querySelectorAll('[style]')]
                .filter(el => el.style.height === '100vh' || el.style.minHeight === '100vh')
                .map(el => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 40) }));
            return { cssRules, inlineStyles };
        }""")

        if vh_usage["cssRules"] or vh_usage["inlineStyles"]:
            issues.append({
                "severity": "medium",
                "description": (
                    f'100vh used in {len(vh_usage["cssRules"])} CSS rule(s) — '
                    "on iOS Safari this includes the address bar height, causing content to be obscured"
                ),
                "recommendation": "Replace 100vh with 100dvh (dynamic viewport height)",
                "detail": vh_usage["cssRules"][:3],
            })
        else:
            passed_checks.append("No 100vh usage detected in CSS rules")

        # 5. Horizontal overflow
        overflow_x = page.evaluate("""() => {
            const docWidth = document.documentElement.scrollWidth;
            const vw = window.innerWidth;
            const offenders = [];
            if (docWidth > vw + 5) {
                for (const el of document.querySelectorAll('*')) {
                    const rect = el.getBoundingClientRect();
                    if (rect.right > vw + 5) {
                        offenders.push({
                            tag: el.tagName,
                            className: (el.className || '').toString().slice(0, 60),
                            right: Math.round(rect.right),
                            vw
                        });
                        if (offenders.length >= 5) break;
                    }
                }
            }
            return { docWidth, vw, offenders };
        }""")

        if overflow_x["offenders"]:
            issues.append({
                "severity": "high",
                "description": (
                    f'Horizontal overflow at 375px: page scrollWidth={overflow_x["docWidth"]}px '
                    f'> viewport {overflow_x["vw"]}px. {len(overflow_x["offenders"])} offending element(s).'
                ),
                "recommendation": "Add overflow-x: hidden to body or fix wide elements",
                "offenders": overflow_x["offenders"],
            })
        else:
            passed_checks.append(f'No horizontal overflow at 375px (scrollWidth: {overflow_x["docWidth"]}px)')

        # 6. Touch target sizes (44x44 minimum)
        small_targets = page.evaluate("""() => {
            const MIN = 44;
            const results = [];
            const els = document.querySelectorAll('button, a, input, select, [role="button"], [tabindex]');
            for (const el of els) {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                if (rect.width < MIN || rect.height < MIN) {
                    results.push({
                        tag: el.tagName,
                        text: (el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim().slice(0, 30),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    });
                    if (results.length >= 10) break;
                }
            }
            return results;
        }""")

        if small_targets:
            issues.append({
                "severity": "medium",
                "description": (
                    f"{len(small_targets)} interactive element(s) smaller than 44x44px minimum touch target"
                ),
                "recommendation": "Increase button padding or add min-height: 44px / min-width: 44px for mobile",
                "examples": small_targets[:5],
            })
        else:
            passed_checks.append("All visible interactive elements meet 44x44px touch target minimum")

        # 7. Layout integrity
        layout = page.evaluate("""() => ({
            bodyScrollWidth: document.body.scrollWidth,
            rootScrollWidth: document.getElementById('root')?.scrollWidth ?? null,
            vw: window.innerWidth,
            fixedCount: [...document.querySelectorAll('*')]
                .filter(el => window.getComputedStyle(el).position === 'fixed').length
        })""")

        if layout["bodyScrollWidth"] <= 380:
            passed_checks.append(f'Layout intact at 375px (body scrollWidth: {layout["bodyScrollWidth"]}px)')
        else:
            issues.append({
                "severity": "high",
                "description": (
                    f'Body scrollWidth {layout["bodyScrollWidth"]}px exceeds 375px viewport'
                ),
                "recommendation": "Review fixed-width containers; ensure responsive design",
            })

        # 8. Drag-and-drop
        drag_support = page.evaluate("""() => {
            const draggables = document.querySelectorAll('[draggable="true"]').length;
            const reactDrag = [];
            for (const el of document.querySelectorAll('*')) {
                const keys = Object.keys(el).filter(k => k.startsWith('__reactProps'));
                for (const key of keys) {
                    try {
                        const p = el[key];
                        if (p && (p.onDrop || p.onDragOver || p.onDragStart)) {
                            reactDrag.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 40) });
                        }
                    } catch(e) {}
                }
            }
            return { draggables, reactDrag };
        }""")

        if drag_support["draggables"] > 0 or drag_support["reactDrag"]:
            issues.append({
                "severity": "low",
                "description": (
                    f'Drag-and-drop detected ({drag_support["draggables"]} draggable elements, '
                    f'{len(drag_support["reactDrag"])} React drag handler(s)) — '
                    "touch drag is not natively supported without a dedicated touch-drag library"
                ),
                "recommendation": (
                    "Implement touch equivalents via onTouchStart/onTouchMove/onTouchEnd "
                    "or use @dnd-kit/core with touch sensor support"
                ),
            })
        else:
            passed_checks.append("No drag-and-drop detected (no touch-drag compatibility issue)")

        # 9. Simulate touch tap on first button
        first_btn = page.query_selector("button")
        tap_result = "no button found"
        if first_btn:
            try:
                first_btn.tap()
                tap_result = "tap simulated successfully"
                passed_checks.append("Touch tap simulation on first button succeeded")
            except Exception as e:
                tap_result = f"tap failed: {e}"
                issues.append({
                    "severity": "medium",
                    "description": f"Touch tap simulation failed: {e}",
                    "recommendation": "Ensure buttons respond to touch events",
                })

        # Full-page screenshot
        page.screenshot(
            path=os.path.join(RESULTS_DIR, "touch-mobile-375-fullpage.png"),
            full_page=True,
        )

        browser.close()

    # Grade
    critical = sum(1 for i in issues if i["severity"] == "critical")
    high = sum(1 for i in issues if i["severity"] == "high")
    medium = sum(1 for i in issues if i["severity"] == "medium")
    low = sum(1 for i in issues if i["severity"] == "low")

    if critical > 0 or high >= 3:
        grade = "F"
    elif high == 2:
        grade = "D"
    elif high == 1:
        grade = "C"
    elif medium >= 1:
        grade = "B"
    else:
        grade = "A"

    report = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "grade": grade,
        "url": URL,
        "viewport": "375x812 (iPhone SE/13 mini)",
        "summary": (
            f"Grade {grade} — {len(issues)} issue(s) found ({high} high, {medium} medium, {low} low). "
            f"{len(passed_checks)} check(s) passed. "
            "App is desktop-first; no touch swipe handlers detected. "
            f"Touch targets: {'OK' if not any('44' in i['description'] for i in issues) else 'some undersized'}. "
            f"Horizontal overflow: {'none' if not any('overflow' in i['description'].lower() for i in issues) else 'detected'}."
        ),
        "issueCount": {"critical": critical, "high": high, "medium": medium, "low": low},
        "issues": issues,
        "passedChecks": passed_checks,
        "tapSimulation": tap_result,
        "screenshots": [
            os.path.join(RESULTS_DIR, "touch-mobile-375.png"),
            os.path.join(RESULTS_DIR, "touch-mobile-375-fullpage.png"),
        ],
    }

    out_path = os.path.join(RESULTS_DIR, "touch-report.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"Report: {out_path}")
    print(f"Grade: {grade}")
    print(f"Issues: {len(issues)} | Passed: {len(passed_checks)}")
    for issue in issues:
        print(f"  [{issue['severity'].upper()}] {issue['description'][:100]}")

    return report


if __name__ == "__main__":
    run()
