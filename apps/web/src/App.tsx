import { useEffect, useState } from "react";
import { MessageSquarePlus, Moon, Sparkles, Sun } from "lucide-react";
import type { HealthResponse } from "@teach-everything/shared";
import { AssistantRuntimeProvider, useAui } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { useAgentRunAssistantRuntime } from "@/lib/assistant-runtime";
import { useTheme } from "@/lib/theme";
import { api } from "./api";

type ApiState =
  { status: "loading" } | { status: "ready"; data: HealthResponse } | { status: "error" };

const getApiStatusLabel = (apiState: ApiState) => {
  if (apiState.status === "loading") return "Connecting";
  if (apiState.status === "ready") return apiState.data.message;

  return "API unavailable";
};

const getApiStatusIndicatorClass = (apiState: ApiState) => {
  if (apiState.status === "ready") return "bg-emerald-400";
  if (apiState.status === "error") return "bg-red-400";

  return "animate-pulse bg-amber-300";
};

const useApiState = () => {
  const [apiState, setApiState] = useState<ApiState>({ status: "loading" });

  useEffect(() => {
    let active = true;

    const checkApi = async () => {
      try {
        const response = await api.api.health.$get();
        if (!response.ok) throw new Error("API request failed");
        const data = await response.json();
        if (active) setApiState({ status: "ready", data });
      } catch {
        if (active) setApiState({ status: "error" });
      }
    };

    void checkApi();
    return () => {
      active = false;
    };
  }, []);

  return apiState;
};

const Workspace = () => {
  const apiState = useApiState();
  const aui = useAui();
  const { theme, toggleTheme } = useTheme();
  const statusLabel = getApiStatusLabel(apiState);
  const statusIndicatorClass = getApiStatusIndicatorClass(apiState);

  const startNewConversation = () => aui.thread().reset();

  return (
    <main className="flex h-dvh min-h-140 overflow-hidden bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-white/8 bg-[#202522] text-white dark:bg-[#151917] lg:flex">
        <div className="flex h-16 items-center gap-3 border-b border-white/8 px-5">
          <span className="flex size-8 items-center justify-center rounded-md bg-[#d8f26a] text-[#202522]">
            <Sparkles className="size-4" aria-hidden="true" />
          </span>
          <span className="text-sm font-semibold">Teach Everything</span>
        </div>

        <div className="flex flex-1 flex-col px-3 py-4">
          <Button
            type="button"
            variant="ghost"
            onClick={startNewConversation}
            className="h-10 w-full justify-start rounded-md border border-white/10 bg-white/6 px-3 text-white hover:bg-white/10 hover:text-white"
          >
            <MessageSquarePlus aria-hidden="true" />
            New conversation
          </Button>
        </div>

        <div className="border-t border-white/8 px-5 py-4">
          <div className="flex items-center gap-2 text-xs text-white/55">
            <span className={`size-2 rounded-full ${statusIndicatorClass}`} aria-hidden="true" />
            <span className="truncate">{statusLabel}</span>
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b bg-background px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Sparkles className="size-5 text-primary lg:hidden" aria-hidden="true" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">Learning assistant</h1>
              <p className="truncate text-xs text-muted-foreground">Agent Run v1</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <TooltipIconButton
              type="button"
              tooltip={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              onClick={toggleTheme}
              className="size-9"
            >
              {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </TooltipIconButton>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={startNewConversation}
              className="lg:hidden"
              aria-label="Start a new conversation"
            >
              <MessageSquarePlus aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <Thread />
        </div>
      </section>
    </main>
  );
};

export const App = () => {
  const runtime = useAgentRunAssistantRuntime();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Workspace />
    </AssistantRuntimeProvider>
  );
};
