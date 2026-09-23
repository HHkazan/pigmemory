import { useEffect, useRef, useState } from "preact/hooks";

import { api, ApiError, AUTH_REQUIRED_EVENT, json } from "../api.js";

interface AuthStatus {
  enabled: boolean;
  needsSetup: boolean;
  authenticated: boolean;
}

type AuthMode = "loading" | "ready" | "login" | "setup" | "unavailable";

export function AuthGate({ children }: { children: (logout?: () => Promise<void>) => preact.ComponentChildren }) {
  const [mode, setMode] = useState<AuthMode>("loading");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const authEnabled = useRef(false);

  const loadStatus = async () => {
    setMode("loading");
    setError("");
    try {
      const status = await api<AuthStatus>("/api/v1/auth/status");
      authEnabled.current = status.enabled;
      setMode(
        !status.enabled || status.authenticated
          ? "ready"
          : status.needsSetup
            ? "setup"
            : "login",
      );
    } catch (err) {
      setError(errorMessage(err, "无法连接 PigMemory 服务。"));
      setMode("unavailable");
    }
  };

  useEffect(() => {
    void loadStatus();
    const handleRequired = () => {
      authEnabled.current = true;
      setPassword("");
      setConfirmation("");
      setError("登录已过期，请重新输入密码。");
      setMode("login");
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleRequired);
  }, []);

  const submit = async () => {
    const setup = mode === "setup";
    if (!password.trim()) {
      setError(setup ? "请设置访问密码。" : "请输入访问密码。");
      return;
    }
    if (setup && password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(
        setup ? "/api/v1/auth/setup" : "/api/v1/auth/login",
        json("POST", { password }),
      );
      setPassword("");
      setConfirmation("");
      authEnabled.current = true;
      setMode("ready");
    } catch (err) {
      if (!setup && err instanceof ApiError && err.status === 401) {
        setError("密码错误，请重试。");
      } else if (setup && err instanceof ApiError && err.status === 409) {
        setError("访问密码已经设置，请直接登录。");
        setMode("login");
      } else {
        setError(errorMessage(err, setup ? "设置密码失败。" : "登录失败。"));
      }
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api("/api/v1/auth/logout", json("POST"));
    } finally {
      authEnabled.current = true;
      setPassword("");
      setConfirmation("");
      setError("");
      setMode("login");
    }
  };

  if (mode === "ready") {
    return <>{children(authEnabled.current ? logout : undefined)}</>;
  }

  if (mode === "loading") {
    return <AuthFrame>
      <div class="auth-loading" role="status">
        <span class="auth-spinner" />
        <p>正在确认登录状态…</p>
      </div>
    </AuthFrame>;
  }

  if (mode === "unavailable") {
    return <AuthFrame>
      <div class="auth-copy">
        <span class="eyebrow">Connection unavailable</span>
        <h1>暂时无法打开 PigMemory</h1>
        <p>Viewer 已加载，但没有取得鉴权状态。请确认 PigMemory 服务仍在运行。</p>
      </div>
      {error && <div class="notice error" role="alert">{error}</div>}
      <button class="auth-primary" type="button" onClick={() => void loadStatus()}>重新连接</button>
    </AuthFrame>;
  }

  const setup = mode === "setup";
  return <AuthFrame>
    <div class="auth-copy">
      <span class="eyebrow">PigMemory Local</span>
      <h1>{setup ? "设置访问密码" : "欢迎回来"}</h1>
      <p>{setup
        ? "首次打开 Viewer，请先设置一个本机访问密码。"
        : "请输入 PigMemory Viewer 的访问密码。"}</p>
    </div>
    <form class="auth-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>
        <span>{setup ? "新密码" : "密码"}</span>
        <input
          autofocus
          type="password"
          value={password}
          autocomplete={setup ? "new-password" : "current-password"}
          disabled={busy}
          onInput={(event) => setPassword((event.target as HTMLInputElement).value)}
        />
      </label>
      {setup && <label>
        <span>确认密码</span>
        <input
          type="password"
          value={confirmation}
          autocomplete="new-password"
          disabled={busy}
          onInput={(event) => setConfirmation((event.target as HTMLInputElement).value)}
        />
      </label>}
      {error && <div class="notice error" role="alert">{error}</div>}
      <button class="auth-primary" type="submit" disabled={busy}>
        {busy ? (setup ? "正在设置…" : "正在登录…") : (setup ? "设置并进入" : "登录")}
      </button>
    </form>
    <p class="auth-footnote">会话仅保存在当前浏览器的安全 Cookie 中，7 天后需要重新登录。</p>
  </AuthFrame>;
}

function AuthFrame({ children }: { children: preact.ComponentChildren }) {
  return <main class="auth-page">
    <section class="auth-card">
      <img class="auth-mascot" src="/assets/huhu-pig-mascot.png" alt="呼呼猪" />
      {children}
    </section>
  </main>;
}

function errorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : "";
  return message || fallback;
}
