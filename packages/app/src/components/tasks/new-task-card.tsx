import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Paperclip } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  deleteAttachments,
  persistAttachmentFromBlob,
  persistAttachmentFromFileUri,
} from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { pickAndPersistImages } from "@/composer/actions";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { AttachmentPill, AttachmentThumbnail } from "@/components/attachment-pill";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedPaperclip = withUnistyles(Paperclip);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface NewTaskSubmit {
  prompt: string;
  images: AttachmentMetadata[];
}

interface NewTaskModalProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (input: NewTaskSubmit) => void;
}

/**
 * "Add task" dialog for the Affaire column: a single free-text prompt plus
 * optional pictures. On submit the prompt becomes a new task (title derived
 * from its first line) and the pictures ride along to the background agent that
 * analyzes it. Cancelling drops any pictures already persisted so no orphan
 * attachments linger in the store.
 */
export function NewTaskModal({ visible, onClose, onSubmit }: NewTaskModalProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const controlSize = isCompact ? "md" : "sm";
  const { pickImages } = useImageAttachmentPicker();

  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<AttachmentMetadata[]>([]);
  const [resetKey, setResetKey] = useState(0);
  // Set the moment we hand the pictures to the parent, so the close handler
  // knows not to delete them (the new task now owns them).
  const submittedRef = useRef(false);
  const imagesRef = useRef<AttachmentMetadata[]>([]);
  imagesRef.current = images;

  useEffect(() => {
    if (visible) {
      setPrompt("");
      setImages([]);
      submittedRef.current = false;
      setResetKey((key) => key + 1);
    }
  }, [visible]);

  const handlePickImage = useCallback(async () => {
    const picked = await pickAndPersistImages({
      pickImages,
      persister: {
        persistFromBlob: ({ blob, mimeType, fileName }) =>
          persistAttachmentFromBlob({ blob, mimeType, fileName }),
        persistFromFileUri: ({ uri, mimeType, fileName }) =>
          persistAttachmentFromFileUri({ uri, mimeType, fileName }),
      },
    });
    if (picked.length === 0) {
      return;
    }
    setImages((prev) => [...prev, ...picked]);
  }, [pickImages]);

  const handleRemoveImage = useCallback((id: string) => {
    setImages((prev) => {
      const removed = prev.find((image) => image.id === id);
      if (removed) {
        void deleteAttachments([removed]);
      }
      return prev.filter((image) => image.id !== id);
    });
  }, []);

  const handleClose = useCallback(() => {
    if (!submittedRef.current && imagesRef.current.length > 0) {
      void deleteAttachments(imagesRef.current);
    }
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      handleClose();
      return;
    }
    submittedRef.current = true;
    onSubmit({ prompt: trimmed, images: imagesRef.current });
    onClose();
  }, [prompt, onSubmit, onClose, handleClose]);

  const header = useMemo((): SheetHeader => ({ title: t("tasks.newTaskModal.title") }), [t]);

  const footer = useMemo(
    () => (
      <View style={styles.footerRow}>
        <Button style={styles.footerButton} variant="secondary" onPress={handleClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button style={styles.footerButton} onPress={handleSubmit} testID="tasks-new-task-submit">
          {t("tasks.newTaskModal.submit")}
        </Button>
      </View>
    ),
    [handleClose, handleSubmit, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      footer={footer}
      desktopMaxWidth={480}
      testID="tasks-new-task-modal"
    >
      <FormTextInput
        size={controlSize}
        resetKey={resetKey}
        onChangeText={setPrompt}
        placeholder={t("tasks.newTaskModal.promptPlaceholder")}
        multiline
        numberOfLines={4}
        autoFocus={!isCompact}
        style={styles.promptInput}
        testID="tasks-new-task-prompt"
      />

      {images.length > 0 ? (
        <View style={styles.thumbnailRow}>
          {images.map((image) => (
            <TaskAttachmentPill
              key={image.id}
              image={image}
              onRemove={handleRemoveImage}
              openLabel={t("tasks.newTaskModal.attachment")}
              removeLabel={t("tasks.newTaskModal.removeAttachment")}
            />
          ))}
        </View>
      ) : null}

      <Pressable
        onPress={handlePickImage}
        style={attachButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.newTaskModal.addAttachment")}
        testID="tasks-new-task-attach"
      >
        <ThemedPaperclip size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        <Text style={styles.attachLabel}>{t("tasks.newTaskModal.addAttachment")}</Text>
      </Pressable>
    </AdaptiveModalSheet>
  );
}

function noop() {}

// One picked picture, as a removable thumbnail pill. Kept as its own memo
// component so its remove handler is bound per-image without an inline closure
// in the parent's render (the composer's ImageAttachmentPill follows the same
// shape).
const TaskAttachmentPill = memo(function TaskAttachmentPill({
  image,
  onRemove,
  openLabel,
  removeLabel,
}: {
  image: AttachmentMetadata;
  onRemove: (id: string) => void;
  openLabel: string;
  removeLabel: string;
}) {
  const handleRemove = useCallback(() => onRemove(image.id), [onRemove, image.id]);
  return (
    <AttachmentPill
      onOpen={noop}
      onRemove={handleRemove}
      openAccessibilityLabel={openLabel}
      removeAccessibilityLabel={removeLabel}
      testID={`tasks-new-task-attachment-${image.id}`}
    >
      <AttachmentThumbnail metadata={image} />
    </AttachmentPill>
  );
});

function attachButtonStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.attachButton, (hovered || pressed) && styles.attachButtonHovered];
}

const styles = StyleSheet.create((theme) => ({
  promptInput: {
    minHeight: 96,
  },
  thumbnailRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
  attachButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  attachButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  attachLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footerRow: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
}));
