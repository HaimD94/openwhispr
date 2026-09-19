import { useState, useCallback, useEffect, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useChatPersistence } from "./useChatPersistence";
import { useChatStreaming } from "./useChatStreaming";
import { useChatMessageSender } from "./useChatMessageSender";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import { LiveConversationBar } from "./LiveConversationBar";
import { useLiveConversation } from "./useLiveConversation";
import { ChatEmptyIllustration } from "./ChatEmptyIllustration";
import ConversationList from "./ConversationList";
import EmptyChatState from "./EmptyChatState";
import { ConfirmDialog } from "../ui/dialog";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { useDialogs } from "../../hooks/useDialogs";
import { getCachedPlatform } from "../../utils/platform";
import { useSettings } from "../../hooks/useSettings";
import { getBaseLanguageCode } from "../../utils/languageSupport";
import { useToast } from "../ui/useToast";
import type { LiveTurn } from "../../services/geminiLiveAssistant";
import type { Message } from "./types";

const CommandSearch = lazy(() => import("../CommandSearch"));

const platform = getCachedPlatform();

function NewChatEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full -mt-6 select-none">
      <ChatEmptyIllustration />
      <p className="text-xs text-foreground/50 dark:text-foreground/45 text-center max-w-48 mt-4">
        {t("chat.newChatEmpty")}
      </p>
    </div>
  );
}

export default function ChatView() {
  const { t } = useTranslation();
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [isNewChat, setIsNewChat] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const { geminiApiKey, preferredLanguage } = useSettings();
  const { toast } = useToast();
  // Filled once the live conversation exists, which is after the handlers below.
  const stopLiveRef = useRef<() => void>(() => {});

  const persistence = useChatPersistence({
    conversationId: activeConversationId,
    onConversationCreated: (id) => {
      setActiveConversationId(id);
      setRefreshKey((k) => k + 1);
    },
  });

  const streaming = useChatStreaming({
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    onStreamComplete: (_id, content, toolCalls) => {
      persistence.saveAssistantMessage(content, toolCalls);
    },
  });

  const handleSelectConversation = useCallback(
    async (id: number) => {
      if (id === activeConversationId) return;
      stopLiveRef.current();
      setActiveConversationId(id);
      setIsNewChat(false);
      await persistence.loadConversation(id);
    },
    [activeConversationId, persistence]
  );

  const handleNewChat = useCallback(() => {
    stopLiveRef.current();
    setActiveConversationId(null);
    setIsNewChat(true);
    persistence.handleNewChat();
  }, [persistence]);

  const createConversation = useCallback(
    async (text: string) => {
      const title = text.length > 50 ? `${text.slice(0, 50)}...` : text;
      return persistence.createConversation(title);
    },
    [persistence]
  );
  const markChatStarted = useCallback(() => setIsNewChat(false), []);
  const handleTextSubmit = useChatMessageSender({
    conversationId: activeConversationId,
    persistence,
    streaming,
    createConversation,
    onBeforeSend: markChatStarted,
  });

  const handleLiveTurn = useCallback(
    async ({ user, assistant }: LiveTurn) => {
      markChatStarted();
      if (persistence.conversationId === null) {
        await createConversation(user || assistant);
      }
      const added: Message[] = [];
      if (user)
        added.push({ id: crypto.randomUUID(), role: "user", content: user, isStreaming: false });
      if (assistant) {
        added.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistant,
          isStreaming: false,
        });
      }
      persistence.setMessages((messages) => [...messages, ...added]);
      if (user) await persistence.saveUserMessage(user);
      if (assistant) await persistence.saveAssistantMessage(assistant);
    },
    [createConversation, markChatStarted, persistence]
  );

  const live = useLiveConversation({
    apiKey: geminiApiKey,
    language: getBaseLanguageCode(preferredLanguage),
    onTurn: handleLiveTurn,
    onError: (message) =>
      toast({
        title: t("agentMode.live.error"),
        description: message || undefined,
        variant: "destructive",
      }),
  });
  stopLiveRef.current = live.stop;

  const handleArchive = useCallback(
    async (id: number) => {
      await window.electronAPI?.archiveAgentConversation?.(id);
      if (activeConversationId === id) {
        handleNewChat();
      }
      setRefreshKey((k) => k + 1);
    },
    [activeConversationId, handleNewChat]
  );

  const handleDelete = useCallback(
    (id: number) => {
      showConfirmDialog({
        title: t("chat.delete"),
        description: t("chat.deleteConfirm"),
        onConfirm: async () => {
          await window.electronAPI?.deleteAgentConversation?.(id);
          if (activeConversationId === id) {
            handleNewChat();
          }
          setRefreshKey((k) => k + 1);
        },
        variant: "destructive",
      });
    },
    [activeConversationId, handleNewChat, showConfirmDialog, t]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "n") {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewChat]);

  const hasActiveChat =
    activeConversationId !== null || persistence.messages.length > 0 || isNewChat;

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
      {showSearch && (
        <Suspense fallback={null}>
          <CommandSearch
            open={showSearch}
            onOpenChange={setShowSearch}
            mode="conversations"
            onConversationSelect={handleSelectConversation}
          />
        </Suspense>
      )}
      <div className="flex h-full">
        <div className="w-56 min-w-50 shrink-0 border-e border-border dark:border-white/10">
          <ConversationList
            activeConversationId={activeConversationId}
            onSelectConversation={handleSelectConversation}
            onNewChat={handleNewChat}
            onOpenSearch={() => setShowSearch(true)}
            onArchive={handleArchive}
            onDelete={handleDelete}
            refreshKey={refreshKey}
          />
        </div>
        <div className="flex-1 min-w-80 flex flex-col">
          {hasActiveChat ? (
            <>
              <ChatMessages
                messages={persistence.messages}
                emptyState={<NewChatEmptyState />}
                contentClassName={PAGE_CONTENT_WIDTH_CLASS}
              />
              <div className="px-3 pb-3 pt-1">
                {live.status !== "idle" ? (
                  <div className={PAGE_CONTENT_WIDTH_CLASS}>
                    <LiveConversationBar
                      status={live.status}
                      caption={live.caption}
                      onStop={live.stop}
                    />
                  </div>
                ) : (
                  <ChatInput
                    className={PAGE_CONTENT_WIDTH_CLASS}
                    agentState={streaming.agentState}
                    partialTranscript=""
                    onTextSubmit={handleTextSubmit}
                    onCancel={streaming.cancelStream}
                    autoFocus={isNewChat}
                    voiceDraft
                    onStartLive={live.start}
                  />
                )}
              </div>
            </>
          ) : (
            <EmptyChatState />
          )}
        </div>
      </div>
    </>
  );
}
