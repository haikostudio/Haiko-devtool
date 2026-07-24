import { useCallback, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { Composer } from "@/composer";
import type { MessagePayload } from "@/composer/types";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import type { UserComposerAttachment } from "@/attachments/types";

interface NewTaskCardProps {
  serverId: string;
  cwd: string;
  // Stable per-column key so the composer namespaces its draft state; not a real
  // agent — the same trick the "new workspace" composer uses.
  draftKey: string;
  onSubmit: (input: { text: string; attachments: AgentAttachment[] }) => void;
  onCancel: () => void;
}

/**
 * Inline "new task" card rendered at the top of the backlog column. It reuses
 * the chat composer (prompt field + paperclip attachments) so creating a task
 * feels exactly like sending a prompt: describe the task, optionally attach a
 * file, hit send. On submit the parent creates the task (which spawns the
 * pipeline agent) and swaps this draft for the real task card.
 */
export function NewTaskCard({ serverId, cwd, draftKey, onSubmit, onCancel }: NewTaskCardProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<UserComposerAttachment[]>([]);

  const clearDraft = useCallback(() => {
    setText("");
    setAttachments([]);
  }, []);

  const handleSubmitMessage = useCallback(
    async (payload: MessagePayload) => {
      const trimmed = payload.text.trim();
      const { attachments: agentAttachments } = splitComposerAttachmentsForSubmit(
        payload.attachments,
      );
      if (!trimmed && agentAttachments.length === 0) {
        onCancel();
        return;
      }
      onSubmit({ text: trimmed, attachments: agentAttachments });
    },
    [onSubmit, onCancel],
  );

  return (
    <View style={styles.card} testID="tasks-new-task-card">
      <View style={styles.composerBleed}>
        <Composer
          agentId={draftKey}
          serverId={serverId}
          isPaneFocused
          value={text}
          onChangeText={setText}
          attachments={attachments}
          onChangeAttachments={setAttachments}
          cwd={cwd}
          clearDraft={clearDraft}
          onSubmitMessage={handleSubmitMessage}
          submitIcon="return"
          submitButtonAccessibilityLabel={t("tasks.actions.add")}
          submitButtonTestID="tasks-new-task-save"
          externalKeyboardShift
          autoFocus
        />
      </View>
      <View style={styles.actionsRow}>
        <Button size="sm" variant="ghost" onPress={onCancel} testID="tasks-new-task-cancel">
          {t("common.actions.cancel")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    // The composer already insets its field by spacing[4] on the sides and
    // bottom but adds nothing on top. Match that with a top-only inset and drop
    // the card's own horizontal/bottom padding so the gap around the field is
    // uniform on all four sides instead of tight-top / wide-sides.
    paddingTop: theme.spacing[4],
    paddingHorizontal: 0,
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
  },
  composerBleed: {
    // Cancel the composer's built-in bottom inset so the action row sits snug
    // under the field instead of floating far below it.
    marginBottom: -theme.spacing[4],
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
}));
