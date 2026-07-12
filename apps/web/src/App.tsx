import { useEffect, useState } from "react";
import { MessageSquarePlus, Sparkles } from "lucide-react";
import type { HealthResponse } from "@teach-everything/shared";
import { AssistantRuntimeProvider, useAssistantRuntime } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import { usePreviewAssistantRuntime } from "@/lib/assistant-runtime";
import { api } from "./api";

type ApiState =
  { status: "loading" } | { status: "ready"; data: HealthResponse } | { status: "error" };

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
  const runtime = useAssistantRuntime();
  const statusLabel =
    apiState.status === "loading"
      ? "Connecting"
      : apiState.status === "ready"
        ? apiState.data.message
        : "API unavailable";

  const startNewConversation = () => runtime.thread.reset();

  return (
    <main className="flex h-dvh min-h-[560px] overflow-hidden bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-white/8 bg-[#202522] text-white lg:flex">
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
            <span
              className={`size-2 rounded-full ${
                apiState.status === "ready"
                  ? "bg-emerald-400"
                  : apiState.status === "error"
                    ? "bg-red-400"
                    : "animate-pulse bg-amber-300"
              }`}
              aria-hidden="true"
            />
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
              <p className="truncate text-xs text-muted-foreground">Preview runtime</p>
            </div>
          </div>
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
        </header>

        <div className="min-h-0 flex-1">
          <Thread />
        </div>
      </section>
    </main>
  );
};

export const App = () => {
  const runtime = usePreviewAssistantRuntime();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Workspace />
    </AssistantRuntimeProvider>
  );
};
