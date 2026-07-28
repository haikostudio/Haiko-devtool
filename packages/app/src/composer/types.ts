import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

export interface ComposerFocusInputOptions {
  /**
   * Focus the input on native too, raising the keyboard. Off by default: most
   * callers focus after a config tap, where a keyboard would be intrusive.
   */
  raiseKeyboardOnNative?: boolean;
}

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
}
