// Browser layout regression check (not a node test). Serve the UI with fixture data:
//   node test/web/check-server.mjs --port 5187 --mode fixture
// open http://127.0.0.1:5187/ at 360x780, 390x844 and 430x932 (and 1440x900), then paste this into the console
// (or run it through a browser-automation tool). It visits every route, opens every <details>, and reports page-wide
// horizontal overflow, elements past the right edge (outside intentional scrollers), squeezed definition values and
// narrow JSON blocks. Every route should report sw === iw and empty lists.
// TEST FIXTURE — NOT MARKET DATA: the fixture server never serves real market data.
(async () => {
  const routes = ['#/overview', '#/research', '#/research/ZVZZT', '#/lab', '#/lab?sym=ZVZZT', '#/agents', '#/replay', '#/journal', '#/sources', '#/about', '#/more'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  for (const r of routes) {
    location.hash = r;
    await sleep(1000);
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
    await sleep(250);
    const iw = window.innerWidth;
    const sw = document.documentElement.scrollWidth;
    const past = [...document.querySelectorAll('main *')]
      .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > iw + 1 && !e.closest('.scroll-x, .lenses'); })
      .slice(0, 5).map((e) => `${e.tagName.toLowerCase()}.${e.className}`);
    const squeezedDd = [...document.querySelectorAll('dl.kv dd')].filter((d) => d.offsetParent && d.getBoundingClientRect().width < 30).length;
    const narrowPre = [...document.querySelectorAll('pre.payload')].filter((p) => p.offsetParent && p.clientWidth < 120).length;
    out.push({ route: r, iw, sw, past, squeezedDd, narrowPre });
  }
  console.table(out);
  return out;
})();
