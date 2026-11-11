// README images from the real VS Code (not a mock): light/dark stills and a GIF tour, recorded
// against the sample gateway. Same output sizes as Gitline's README: 1200x680 window (2x stills),
// GIF at 880px / 12 fps.
//
//   npm run build && node --import tsx test/e2e/readme-images.ts
//
// Writes docs/images/{overview,add-api}-{dark,light}.png and docs/images/tour.gif
// (frames and the intermediate MP4 go to out-demo/, which is git-ignored).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Frame, Page } from "@playwright/test";
import { launchVSCode, REPO, sleep, type VSCodeSession } from "./vscode";
import { startSampleGateway } from "../fixtures/sample-gateway";

const IMAGES = path.join(REPO, "docs", "images");
const OUT = path.join(REPO, "out-demo");
const TITLE_BAR = 35; // VS Code's custom title bar height (CSS px); cropped out of the stills
const CLIP = { x: 0, y: TITLE_BAR, width: 1200, height: 680 };
const THEMES = { dark: "Default Dark Modern", light: "Default Light Modern" } as const;

async function frameWith(win: Page, selector: string, tries = 40): Promise<Frame> {
  for (let i = 0; i < tries; i++) {
    for (const f of win.frames())
      if (
        await f
          .locator(selector)
          .count()
          .catch(() => 0)
      )
        return f;
    await sleep(250);
  }
  throw new Error(`no frame with ${selector}`);
}

// Close the secondary side bar (Chat) so the shot shows only this extension.
async function tidy(s: VSCodeSession) {
  if (
    await s.win
      .locator(".part.auxiliarybar")
      .isVisible()
      .catch(() => false)
  ) {
    await s.win.locator('.titlebar [aria-label^="Toggle Secondary Side Bar"]').first().click();
    await sleep(500);
  }
}

// Record the page with CDP screencast while `run` executes; returns frames with their timestamps.
async function record(win: Page, run: () => Promise<void>): Promise<{ file: string; t: number }[]> {
  const dir = path.join(OUT, "frames");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await win.context().newCDPSession(win);
  const frames: { file: string; t: number }[] = [];
  cdp.on("Page.screencastFrame", async (e: any) => {
    const file = path.join(dir, `${String(frames.length).padStart(5, "0")}.png`);
    frames.push({ file, t: e.metadata.timestamp });
    fs.writeFileSync(file, Buffer.from(e.data, "base64"));
    await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await run();
  await cdp.send("Page.stopScreencast");
  return frames;
}

// Frames (variable timing) → constant 12 fps GIF, 880 px wide, with a generated palette.
function toGif(frames: { file: string; t: number }[], gif: string) {
  const list = path.join(OUT, "frames.txt");
  const lines: string[] = [];
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.t ?? f.t + 1.5;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.01, next - f.t).toFixed(3)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(list, lines.join("\n"));
  const mp4 = path.join(OUT, "tour.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-vf",
    `fps=30,crop=iw:ih*${CLIP.height}/${CLIP.height + TITLE_BAR}:0:ih*${TITLE_BAR}/${CLIP.height + TITLE_BAR},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    "-pix_fmt",
    "yuv420p",
    mp4,
  ]);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    mp4,
    "-vf",
    "fps=12,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    gif,
  ]);
}

async function scene(theme: keyof typeof THEMES, gatewayOrigin: string, withGif: boolean) {
  const s = await launchVSCode(
    { "swaggerViewer.specs": [{ name: "Sample Gateway", url: `${gatewayOrigin}/swagger-ui/index.html` }] },
    {
      windowSize: [1200, 680 + TITLE_BAR], // the title bar is cropped from the stills
      userSettings: {
        "workbench.colorTheme": THEMES[theme],
        "workbench.startupEditor": "none",
        "chat.commandCenter.enabled": false,
        "workbench.tips.enabled": false,
      },
    }
  );
  try {
    await tidy(s);
    await s.showOpenApiView();
    for (const label of ["Sample Gateway", "learning", "학습자 관리"]) {
      await s.row(label).click();
      await sleep(1500);
    }

    const tour = async () => {
      await s.row("GET /api/v1/learning/r0/{id}").click();
      const ui = await frameWith(s.win, "#swagger-ui .opblock.is-open");
      await sleep(1500);
      const op = ui.locator(".opblock.is-open").first();
      await op.locator("button.try-out__btn").click();
      await sleep(700);
      await op.locator('input[placeholder="id"]').fill("7");
      await sleep(600);
      await op.locator("button.execute").click();
      await op.locator(".live-responses-table tbody .response-col_status").first().waitFor();
      await sleep(400);
      await op.locator(".responses-wrapper").scrollIntoViewIfNeeded();
      await sleep(2200);
    };
    if (withGif) {
      const frames = await record(s.win, tour);
      toGif(frames, path.join(IMAGES, "tour.gif"));
      console.log(`tour.gif from ${frames.length} frames`);
    } else {
      await tour();
    }
    // Overview still: the opened method from its header down, response included.
    const ui = await frameWith(s.win, "#swagger-ui .opblock.is-open");
    await ui
      .locator(".opblock.is-open .opblock-summary")
      .first()
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await sleep(600);
    await s.win.screenshot({ path: path.join(IMAGES, `overview-${theme}.png`), clip: CLIP });

    // Add API: ＋ in the view title adds a "New API" node and opens its settings tab in the editor.
    await s.win.locator(".part.sidebar .composite.title").first().hover();
    await sleep(300);
    await s.win.locator('.part.sidebar .action-label[aria-label^="Add API"]').first().click();
    const tab = await frameWith(s.win, "#url");
    await tab.locator("#url").fill("https://api.example.com/v3/api-docs");
    await tab.getByLabel("Bearer token").check();
    await tab.locator("#token").fill("example-token");
    await sleep(800);
    await s.win.screenshot({ path: path.join(IMAGES, `add-api-${theme}.png`), clip: CLIP });
    console.log(`${theme}: stills written`);
  } finally {
    await s.close();
  }
}

(async () => {
  fs.mkdirSync(IMAGES, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const gw = await startSampleGateway();
  try {
    await scene("dark", gw.origin, true);
    await scene("light", gw.origin, false);
  } finally {
    await gw.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
