import { useEffect, useState } from "preact/hooks";

import { EntityPage } from "./components/EntityPage.js";
import { GuidePage } from "./components/GuidePage.js";
import { LogsPage } from "./components/LogsPage.js";
import { OverviewPage } from "./components/OverviewPage.js";
import { RetrievalPage } from "./components/RetrievalPage.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { TodayChangesPage } from "./components/TodayChangesPage.js";
import { UserProfilePage } from "./components/UserProfilePage.js";

type RouteKey = "overview" | "today" | "profile" | "logs" | "retrieval" | "traces" | "policies" | "skills" | "world" | "episodes" | "guide" | "settings";

const nav: Array<{ key: RouteKey; label: string; short: string }> = [
  { key: "overview", label: "总览与健康", short: "总览" },
  { key: "today", label: "今日记忆变化", short: "今日变化" },
  { key: "profile", label: "用户画像与每日记忆", short: "用户画像" },
  { key: "logs", label: "会话日志", short: "日志" },
  { key: "retrieval", label: "检索复盘", short: "检索" },
  { key: "traces", label: "记忆（Trace）", short: "记忆" },
  { key: "policies", label: "策略（Policy）", short: "策略" },
  { key: "skills", label: "技能（Skill）", short: "技能" },
  { key: "world", label: "世界模型（World Model）", short: "世界模型" },
  { key: "episodes", label: "任务片段（Episode）", short: "任务" },
  { key: "guide", label: "原理讲解", short: "讲解" },
  { key: "settings", label: "设置（Config）", short: "设置" },
];

function routeFromHash(): RouteKey {
  const key = location.hash.replace(/^#\/?/, "").split(/[?&]/)[0] as RouteKey;
  return nav.some((item) => item.key === key) ? key : "overview";
}

export function App({ onLogout }: { onLogout?: () => Promise<void> }) {
  const [route, setRoute] = useState<RouteKey>(routeFromHash());
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const handler = () => { setRoute(routeFromHash()); setMenu(false); };
    addEventListener("hashchange", handler);
    fetch("/api/v1/telemetry/viewer-opened", { method: "POST" }).catch(() => undefined);
    return () => removeEventListener("hashchange", handler);
  }, []);

  const page = route === "overview"
    ? <OverviewPage />
    : route === "today"
      ? <TodayChangesPage />
    : route === "profile"
      ? <UserProfilePage />
    : route === "logs"
      ? <LogsPage />
      : route === "retrieval"
        ? <RetrievalPage />
        : route === "guide"
          ? <GuidePage />
          : route === "settings"
            ? <SettingsPage />
            : <EntityPage kind={route} />;

  return <div class="shell">
    <aside class={menu ? "sidebar open" : "sidebar"}>
      <div class="brand">
        <img class="brand-mark" src="/assets/huhu-pig-mascot.png" alt="呼呼猪" />
        <div><strong>PigMemory</strong><span>呼呼猪本地监控</span></div>
      </div>
      <nav>
        {nav.map((item) => <a
          class={route === item.key ? "active" : ""}
          href={`#/${item.key}`}
          title={item.label}
        ><span class="nav-dot" />{item.label}</a>)}
      </nav>
      <div class="sidebar-foot"><img src="/assets/huhu-pig-mascot.png" alt="呼呼猪" /><span>时区：Asia/Shanghai<br />数据时间戳：UTC 毫秒</span></div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <button class="menu-button" onClick={() => setMenu(!menu)}>☰</button>
        <div><span class="eyebrow">PigMemory Local</span><h1>{nav.find((item) => item.key === route)?.label}</h1></div>
        <div class="topbar-actions">
          <div class="clock-label">北京时间</div>
          {onLogout && <button class="logout-button" type="button" onClick={() => void onLogout()}>退出登录</button>}
        </div>
      </header>
      <main>{page}</main>
    </div>
    {menu && <button class="scrim" onClick={() => setMenu(false)} aria-label="关闭导航" />}
  </div>;
}
