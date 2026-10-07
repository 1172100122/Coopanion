/**
 * 字标下面那一行:当前版本与项目地址;GitHub 上最新的正式 Release 比当前版本新时,再多一行去下载的链接。
 * 版本号由 scripts/stage.ts 从 package.json 写进 app-version.ts。查询失败就只显示当前版本。
 */
import { pick } from '../core/language.ts';
import { APP_VERSION } from '../app-version.ts';

export const REPO_URL = 'https://github.com/Pal-AI-Lab/Coopanion';

const S = pick({
  zh: {
    repoHint: '查看 Coopanion 上游源码（本定制版不自动更新）',
    update: (latest: string) => `Coopanion ${latest} 已发布,点这里下载更新`,
  },
  en: {
    repoHint: 'View Coopanion upstream source (automatic updates disabled in this fork)',
    update: (latest: string) => `Coopanion ${latest} is out: download the update`,
  },
});

export interface ReleaseUpdate { version: string; url: string }

function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

export function isNewer(latest: string, current: string): boolean {
  const left = versionParts(latest);
  const right = versionParts(current);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]!;
  }
  return false;
}

/** This fork has no release channel; upstream binaries do not contain Hachimist. */
export function checkRelease(): Promise<ReleaseUpdate | null> {
  return Promise.resolve(null);
}

function link(doc: Document, className: string, text: string, href: string): HTMLAnchorElement {
  const a = doc.createElement('a');
  a.className = className;
  a.textContent = text;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/** 把版本行放进字标容器;有新版本时在它下面补上下载链接。 */
export function mountRelease(doc: Document, brand: Element, signal: AbortSignal): void {
  const repo = link(doc, 'companion-version', `v${APP_VERSION} · GitHub`, REPO_URL);
  repo.title = S.repoHint;
  brand.appendChild(repo);
  void checkRelease().then((update) => {
    if (signal.aborted || !update) return;
    brand.appendChild(link(doc, 'release-hint', S.update(update.version), update.url));
  });
}
