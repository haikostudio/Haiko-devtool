export interface StreamMagicScrollbarEntry {
  /** Stream item id of the user message; passed back through onJumpToEntry. */
  id: string;
  /** Raw user message text; the hover tooltip clamps it to three lines. */
  text: string;
}

export interface StreamMagicScrollbarProps {
  /** User messages in visual (top-to-bottom) order. */
  entries: StreamMagicScrollbarEntry[];
  /**
   * Slide the rail in (scroll activity or conversation-pane hover).
   * Hovering the rail itself keeps it open regardless of this flag.
   */
  visible: boolean;
  /** User message currently at the top of the viewport (the turn being read). */
  activeEntryId?: string | null;
  onJumpToEntry: (entryId: string) => void;
}
