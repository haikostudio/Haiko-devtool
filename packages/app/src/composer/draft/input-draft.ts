import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserComposerAttachment } from "@/attachments/types";
import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { DraftCommandConfig } from "@/hooks/use-agent-commands-query";
import {
  useAgentFormState,
  type CreateAgentInitialValues,
  type UseAgentFormStateResult,
} from "@/hooks/use-agent-form-state";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import {
  areAttachmentsEqual,
  buildDraftAgentControls,
  hasDraftContent,
  resolveDraftKey,
  type DraftKeyInput,
} from "@/composer/draft/input-draft-core";
import {
  buildDraftCommandConfig,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  type ProviderSelectionState,
} from "@/provider-selection/provider-selection";
import { useDraftStore } from "@/stores/draft-store";
import {
  clearLiveComposerAttachmentIds,
  setLiveComposerAttachmentIds,
} from "@/attachments/live-attachment-refs";

type AttachmentUpdater =
  | UserComposerAttachment[]
  | ((prev: UserComposerAttachment[]) => UserComposerAttachment[]);

interface AgentInputDraftComposerOptions {
  initialServerId: string | null;
  initialValues?: CreateAgentInitialValues;
  initialFeatureValues?: Record<string, unknown>;
  isVisible?: boolean;
  onlineServerIds?: string[];
  lockedWorkingDir?: string;
}

interface UseAgentInputDraftInput {
  draftKey: DraftKeyInput;
  composer?: AgentInputDraftComposerOptions;
}

type DraftComposerState = UseAgentFormStateResult & {
  workingDir: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues: Record<string, unknown> | undefined;
  agentControls: DraftAgentControlsProps;
  commandDraftConfig: DraftCommandConfig | undefined;
};

export interface AgentInputDraft {
  text: string;
  setText: (text: string) => void;
  attachments: UserComposerAttachment[];
  setAttachments: (updater: AttachmentUpdater) => void;
  clear: (lifecycle: "sent" | "abandoned") => void;
  isHydrated: boolean;
  composerState: DraftComposerState | null;
  /** Report text-input focus so cross-device draft updates are adopted in place
   * only while the user is NOT actively typing here. */
  notifyInputFocus: (focused: boolean) => void;
}

export function useAgentInputDraft(input: UseAgentInputDraftInput): AgentInputDraft {
  const composerOptions = input.composer ?? null;
  const formState = useAgentFormState({
    initialServerId: composerOptions?.initialServerId ?? null,
    initialValues: composerOptions?.initialValues,
    isVisible: composerOptions?.isVisible ?? false,
    isCreateFlow: true,
    onlineServerIds: composerOptions?.onlineServerIds ?? [],
  });
  const draftKey = useMemo(
    () =>
      resolveDraftKey({
        draftKey: input.draftKey,
        selectedServerId: formState.selectedServerId,
      }),
    [formState.selectedServerId, input.draftKey],
  );
  const [text, setText] = useState("");
  const [attachments, setAttachmentsState] = useState<UserComposerAttachment[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const draftGenerationRef = useRef(0);
  const hydratedGenerationRef = useRef(0);
  // Mirrors of the live local state + input focus, read by the store subscription
  // below without re-subscribing on every keystroke.
  const textRef = useRef(text);
  const attachmentsRef = useRef(attachments);
  const inputFocusedRef = useRef(false);
  textRef.current = text;
  attachmentsRef.current = attachments;

  const setAttachments = useCallback((updater: AttachmentUpdater) => {
    setAttachmentsState((previousAttachments) => {
      if (typeof updater === "function") {
        return updater(previousAttachments);
      }
      return updater;
    });
  }, []);

  const clear = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      const store = useDraftStore.getState();
      store.clearDraftInput({ draftKey, lifecycle });

      const generation = store.beginDraftGeneration(draftKey);
      draftGenerationRef.current = generation;
      hydratedGenerationRef.current = generation;

      setText("");
      setAttachmentsState([]);
      setIsHydrated(true);
    },
    [draftKey],
  );

  useEffect(() => {
    const store = useDraftStore.getState();
    const generation = store.beginDraftGeneration(draftKey);
    draftGenerationRef.current = generation;
    hydratedGenerationRef.current = 0;

    setText("");
    setAttachmentsState([]);
    setIsHydrated(false);

    let cancelled = false;

    void (async () => {
      const draft = await store.hydrateDraftInput({
        draftKey,
      });
      if (cancelled) {
        return;
      }
      if (!useDraftStore.getState().isDraftGenerationCurrent({ draftKey, generation })) {
        return;
      }

      if (draft) {
        setText(draft.text);
        setAttachmentsState(draft.attachments);
      }

      hydratedGenerationRef.current = generation;
      setIsHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  useEffect(() => {
    const currentGeneration = draftGenerationRef.current;
    if (currentGeneration <= 0) {
      return;
    }

    const store = useDraftStore.getState();
    const isCurrentGeneration = store.isDraftGenerationCurrent({
      draftKey,
      generation: currentGeneration,
    });
    if (!isCurrentGeneration) {
      return;
    }
    if (hydratedGenerationRef.current !== currentGeneration) {
      return;
    }

    const existing = store.getDraftInput(draftKey);
    const isSameDraft =
      existing !== undefined &&
      existing.text === text &&
      areAttachmentsEqual({
        left: existing.attachments,
        right: attachments,
      });
    if (isSameDraft) {
      return;
    }

    if (!hasDraftContent({ text, attachments })) {
      if (existing) {
        store.clearDraftInput({ draftKey, lifecycle: "abandoned" });
      }
      return;
    }

    store.saveDraftInput({
      draftKey,
      draft: {
        text,
        attachments,
      },
    });
  }, [attachments, draftKey, text]);

  // Adopt a draft that changed in the store from outside this composer (a remote
  // cross-device update applied via hydrateWorkspaceUiState, or an image whose
  // bytes were just materialized locally) into the local input, in place. Our own
  // saves keep the store equal to local state, so this is a no-op for them.
  //
  // Text is user content: never yank it out from under active typing, so text is
  // adopted only while the input is NOT focused (on blur we run once to catch up).
  // Attachments are NOT typed content — an attachment metadata swap (e.g. a
  // materialized image's storageKey flipping from the sender's key to the local
  // one) must apply even while the input is focused, otherwise a focused/open
  // composer shows a broken image until it is closed and reopened.
  const adoptRemoteDraft = useCallback(() => {
    if (draftGenerationRef.current <= 0) {
      return;
    }
    if (hydratedGenerationRef.current !== draftGenerationRef.current) {
      return;
    }
    const store = useDraftStore.getState();
    const record = store.drafts[draftKey];
    if (!record) {
      return;
    }
    // A sent/abandoned tombstone means the composer was cleared on another device
    // (message sent, or the field emptied). Adopt the empty state so the field
    // clears here too. An active-but-not-yet-ready draft (e.g. an image still
    // migrating) is skipped; a later store change retries.
    const isActive = record.lifecycle === "active";
    const remote = isActive ? store.getDraftInput(draftKey) : undefined;
    if (isActive && !remote) {
      return;
    }
    const remoteText = remote?.text ?? "";
    const remoteAttachments = remote?.attachments ?? [];
    if (
      !areAttachmentsEqual({
        left: remoteAttachments,
        right: attachmentsRef.current,
      })
    ) {
      // A non-empty change (e.g. a materialized image's storageKey swap, or an
      // attachment added on another device) is adopted even while focused — it
      // never removes what the user is holding. But EMPTYING the list (a
      // sent/abandoned tombstone) must respect focus, exactly like text: never
      // yank an attachment the local user just added/pasted out from under them.
      if (remoteAttachments.length > 0 || !inputFocusedRef.current) {
        setAttachmentsState(remoteAttachments);
      }
    }
    if (inputFocusedRef.current) {
      return;
    }
    if (remoteText !== textRef.current) {
      setText(remoteText);
    }
  }, [draftKey]);

  useEffect(() => {
    const unsubscribe = useDraftStore.subscribe((state, previous) => {
      if (state.drafts[draftKey] === previous.drafts[draftKey]) {
        return;
      }
      adoptRemoteDraft();
    });
    return unsubscribe;
  }, [draftKey, adoptRemoteDraft]);

  const notifyInputFocus = useCallback(
    (focused: boolean) => {
      inputFocusedRef.current = focused;
      if (!focused) {
        adoptRemoteDraft();
      }
    },
    [adoptRemoteDraft],
  );

  // Root the attachment GC on what this composer is actually holding, so a blob
  // the user just pasted is never collected — even if the persisted draft record
  // momentarily goes to an empty tombstone (e.g. a cross-device clear echo) while
  // the focus guard keeps the attachment on screen.
  useEffect(() => {
    const ids = new Set<string>();
    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        ids.add(attachment.metadata.id);
      }
    }
    setLiveComposerAttachmentIds(draftKey, ids);
  }, [attachments, draftKey]);
  useEffect(() => {
    return () => clearLiveComposerAttachmentIds(draftKey);
  }, [draftKey]);

  const lockedWorkingDir = composerOptions?.lockedWorkingDir?.trim() ?? "";
  useEffect(() => {
    if (!composerOptions || !lockedWorkingDir) {
      return;
    }
    if (formState.workingDir.trim() === lockedWorkingDir) {
      return;
    }
    formState.setWorkingDir(lockedWorkingDir);
  }, [composerOptions, formState, lockedWorkingDir]);

  const providerSelection = useMemo<ProviderSelectionState>(
    () => ({
      provider: formState.selectedProvider,
      modelId: formState.selectedModel,
      modeId: formState.selectedMode,
      thinkingOptionId: formState.selectedThinkingOptionId,
      availableModels: formState.availableModels,
      modeOptions: formState.modeOptions,
    }),
    [
      formState.availableModels,
      formState.modeOptions,
      formState.selectedMode,
      formState.selectedModel,
      formState.selectedProvider,
      formState.selectedThinkingOptionId,
    ],
  );

  const effectiveModelId = useMemo(
    () => resolveEffectiveComposerModelId(providerSelection),
    [providerSelection],
  );

  const effectiveThinkingOptionId = useMemo(
    () => resolveEffectiveComposerThinkingOptionId(providerSelection, effectiveModelId),
    [effectiveModelId, providerSelection],
  );

  const workingDir = lockedWorkingDir || formState.workingDir;
  const {
    features: draftFeatures,
    featureValues: draftFeatureValues,
    setFeatureValue: setDraftFeatureValue,
  } = useDraftAgentFeatures({
    serverId: formState.selectedServerId,
    provider: formState.selectedProvider,
    cwd: workingDir,
    modeId: formState.selectedMode,
    modelId: effectiveModelId,
    thinkingOptionId: effectiveThinkingOptionId,
    initialFeatureValues: composerOptions?.initialFeatureValues,
  });

  const commandDraftConfig = useMemo(
    () =>
      composerOptions
        ? buildDraftCommandConfig({
            selection: providerSelection,
            cwd: workingDir,
            effectiveModelId,
            effectiveThinkingOptionId,
            featureValues: draftFeatureValues,
          })
        : undefined,
    [
      composerOptions,
      effectiveModelId,
      effectiveThinkingOptionId,
      draftFeatureValues,
      providerSelection,
      workingDir,
    ],
  );

  const composerState = useMemo<DraftComposerState | null>(() => {
    if (!composerOptions) {
      return null;
    }

    return {
      ...formState,
      workingDir,
      effectiveModelId,
      effectiveThinkingOptionId,
      featureValues: draftFeatureValues,
      agentControls: buildDraftAgentControls({
        formState,
        features: draftFeatures,
        onSetFeature: setDraftFeatureValue,
      }),
      commandDraftConfig,
    };
  }, [
    commandDraftConfig,
    composerOptions,
    effectiveModelId,
    effectiveThinkingOptionId,
    draftFeatures,
    draftFeatureValues,
    formState,
    setDraftFeatureValue,
    workingDir,
  ]);

  return {
    text,
    setText,
    attachments,
    setAttachments,
    clear,
    isHydrated,
    composerState,
    notifyInputFocus,
  };
}

export const __private__ = {
  resolveDraftKey,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  buildDraftCommandConfig,
  buildDraftComposerCommandConfig: buildDraftCommandConfig,
  buildDraftAgentControls,
};
