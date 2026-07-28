import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { StyleProp, TextInputProps, ViewStyle } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getOverlayRoot, OVERLAY_Z } from "../lib/overlay-root";
import {
  BottomSheetBackdrop,
  BottomSheetFooter,
  BottomSheetScrollView,
  BottomSheetTextInput,
  BottomSheetView,
  type BottomSheetBackgroundProps,
  type BottomSheetFooterProps,
} from "@gorhom/bottom-sheet";
import Animated from "react-native-reanimated";
import { ArrowLeft, Search, X } from "lucide-react-native";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { getCompactSheetSafeAreaPadding } from "@/components/adaptive-modal-sheet-layout";
import { createControlGeometry } from "@/components/ui/control-geometry";
import { isNative, isWeb } from "@/constants/platform";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// Horizontal indent token shared by the sheet header (title, back arrow,
// leading icon, search input icon) and any row primitive rendered inside the
// sheet body. Rows whose leading icon should line up with the header must
// match this padding.
export const SHEET_HORIZONTAL_PADDING_SCALE = 4;

export interface SheetHeaderSearch {
  onChange: (value: string) => void;
  resetKey?: string | number;
  placeholder?: string;
  autoFocus?: boolean;
  testID?: string;
}

export interface SheetHeaderBack {
  onPress: () => void;
  label?: string;
  accessibilityLabel?: string;
}

export interface SheetHeader {
  title: string;
  subtitle?: ReactNode;
  back?: SheetHeaderBack;
  leading?: ReactNode;
  actions?: ReactNode;
  search?: SheetHeaderSearch;
}

type EscHandler = () => void;
const escStack: EscHandler[] = [];
let escListenerAttached = false;
const ABSOLUTE_FILL_STYLE = { ...StyleSheet.absoluteFillObject };

function handleEscKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const top = escStack[escStack.length - 1];
  if (!top) return;
  event.stopPropagation();
  event.preventDefault();
  top();
}

function pushEscHandler(handler: EscHandler): () => void {
  escStack.push(handler);
  if (!escListenerAttached && typeof window !== "undefined") {
    window.addEventListener("keydown", handleEscKeyDown, true);
    escListenerAttached = true;
  }
  return () => {
    const index = escStack.lastIndexOf(handler);
    if (index !== -1) escStack.splice(index, 1);
    if (escStack.length === 0 && escListenerAttached && typeof window !== "undefined") {
      window.removeEventListener("keydown", handleEscKeyDown, true);
      escListenerAttached = false;
    }
  };
}

const styles = StyleSheet.create((theme) => ({
  desktopOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
    zIndex: OVERLAY_Z.modal,
    pointerEvents: "auto" as const,
  },
  // Backdrop-less desktop overlay: no dim, and taps fall through to the app
  // behind everywhere except the card itself (pointerEvents "box-none"), so the
  // rest of the screen stays visible and interactive. The user closes via the X.
  desktopOverlayNoBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "transparent",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
    zIndex: OVERLAY_Z.modal,
    pointerEvents: "box-none" as const,
  },
  desktopCard: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "85%",
    flexShrink: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  headerContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  headerRow: {
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingVertical: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerBackButton: {
    borderRadius: theme.borderRadius.lg,
  },
  headerLeadingSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitleGroup: {
    flex: 1,
    gap: theme.spacing[1],
    minWidth: 0,
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  closeButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingBottom: theme.spacing[3],
  },
  // Inline variants for InlineHeaderView inside the desktop Combobox popover.
  // Horizontal padding matches the model picker's row indent: the picker uses
  // children mode (desktopChildrenScrollContent, no scroll padding), so the
  // row content starts at item.paddingHorizontal = spacing[3].
  inlineHeaderRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inlineSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  inlineTitle: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  desktopScrollContainer: {
    flexShrink: 1,
    minHeight: 0,
    position: "relative",
  },
  desktopScroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  desktopContent: {
    padding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    gap: theme.spacing[4],
    flexGrow: 1,
  },
  bottomSheetContent: {
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  bottomSheetStaticContent: {
    flex: 1,
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
    minHeight: 0,
  },
  desktopStaticContent: {
    flexShrink: 1,
    minHeight: 0,
    padding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    gap: theme.spacing[4],
  },
  footer: {
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  // The compact footer floats over the scroll content (BottomSheetFooter), so
  // it needs an opaque sheet-colored background.
  footerCompact: {
    backgroundColor: theme.colors.surface0,
  },
  adaptiveInputOutline: {
    ...createControlGeometry(theme).controlFocusRingColor,
  },
  adaptiveInputText: {
    color: theme.colors.foreground,
  },
  adaptiveInputPlaceholder: {
    color: theme.colors.foregroundMuted,
  },
}));

const SEARCH_INPUT_STYLE = [styles.searchInput, isWeb && { outlineStyle: "none" }];
const WEB_EXIT_DURATION_MS = 160;

function SheetBackground({ style }: BottomSheetBackgroundProps) {
  const { theme } = useUnistyles();
  const combinedStyle = useMemo(
    () => [
      style,
      {
        backgroundColor: theme.colors.surface0,
        borderTopLeftRadius: theme.borderRadius["2xl"],
        borderTopRightRadius: theme.borderRadius["2xl"],
      },
    ],
    [style, theme.colors.surface0, theme.borderRadius],
  );
  return <Animated.View pointerEvents="none" style={combinedStyle} />;
}

export type AdaptiveTextInputProps = TextInputProps & {
  initialValue?: string;
  resetKey?: string | number;
};

// React Native controlled TextInput can replay stale JS values during fast input
// and visibly flicker/cursor-jump. Keep the rendered text native-owned; callers
// can seed it once with initialValue and remount with resetKey for real resets.
// See https://github.com/facebook/react-native/issues/44157
//
// Text color and placeholder color are owned by this leaf — not the caller.
// `@gorhom/bottom-sheet` mounts header subtrees before the sheet is visible
// under whatever theme is active at mount time, then keeps them mounted across
// theme changes; any caller that paints color via `StyleSheet.create((theme) =>
// ...)` from outside this leaf ends up with stale colors in dark mode (see
// docs/unistyles.md "Hidden Sheet Content"). withUnistyles wraps the actual
// TextInput so theme-driven re-renders land on the wrapper.
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ThemedBottomSheetTextInput = withUnistyles(BottomSheetTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export const AdaptiveTextInput = forwardRef<TextInput, AdaptiveTextInputProps>(
  function AdaptiveTextInputInner(props, ref) {
    const isMobile = useIsCompactFormFactor();
    const { value: _value, initialValue, resetKey, defaultValue, style, ...inputProps } = props;
    // Leaf-owned color goes LAST so callers cannot override it with a stale
    // theme read. Outline color is theme-aware on web :focus-visible.
    const textInputProps = {
      ...inputProps,
      defaultValue: initialValue ?? defaultValue,
      style: [styles.adaptiveInputOutline, style, styles.adaptiveInputText],
    };

    if (isMobile && isNative) {
      return (
        <ThemedBottomSheetTextInput
          key={resetKey}
          ref={ref as unknown as Ref<never>}
          {...textInputProps}
        />
      );
    }
    return <ThemedTextInput key={resetKey} ref={ref} {...textInputProps} />;
  },
);

export function SheetHeaderView({
  header,
  onClose,
  showCloseButton = true,
  testID,
}: {
  header: SheetHeader;
  onClose: () => void;
  showCloseButton?: boolean;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const back = header.back;
  const handleBackPress = back?.onPress;
  const search = header.search;
  const handleSearchChange = useCallback(
    (value: string) => {
      search?.onChange(value);
    },
    [search],
  );

  return (
    <View style={styles.headerContainer} testID={testID}>
      <View style={styles.headerRow}>
        {handleBackPress ? (
          <Pressable
            onPress={handleBackPress}
            hitSlop={8}
            style={styles.headerBackButton}
            accessibilityRole="button"
            accessibilityLabel={back?.accessibilityLabel ?? back?.label ?? t("common.actions.back")}
            testID="sheet-header-back"
          >
            {({ pressed }) => (
              <ArrowLeft
                size={18}
                color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        ) : null}
        {header.leading ? <View style={styles.headerLeadingSlot}>{header.leading}</View> : null}
        <View style={styles.headerTitleGroup}>
          <Text style={titleStyle} numberOfLines={1}>
            {header.title}
          </Text>
          {header.subtitle}
        </View>
        {header.actions ? <View style={styles.headerActions}>{header.actions}</View> : null}
        {showCloseButton ? (
          <Pressable
            accessibilityLabel={t("common.actions.close")}
            style={styles.closeButton}
            onPress={onClose}
          >
            {({ pressed }) => (
              <X
                size={16}
                color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        ) : null}
      </View>
      {search ? (
        <View style={styles.searchRow}>
          <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <AdaptiveTextInput
            // @ts-expect-error - outlineStyle is web-only
            style={SEARCH_INPUT_STYLE}
            placeholder={search.placeholder ?? t("common.actions.search")}
            resetKey={search.resetKey}
            onChangeText={handleSearchChange}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={search.autoFocus}
            testID={search.testID}
          />
        </View>
      ) : null}
    </View>
  );
}

export function InlineHeaderView({ header }: { header: SheetHeader }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const back = header.back;
  const handleBackPress = back?.onPress;
  const hasInlineRow = Boolean(handleBackPress || header.leading || header.actions);
  if (!hasInlineRow && !header.search) return null;
  return (
    <View>
      {hasInlineRow ? (
        <View style={styles.inlineHeaderRow}>
          {handleBackPress ? (
            <Pressable
              onPress={handleBackPress}
              hitSlop={8}
              style={styles.headerBackButton}
              accessibilityRole="button"
              accessibilityLabel={
                back?.accessibilityLabel ?? back?.label ?? t("common.actions.back")
              }
              testID="sheet-header-back"
            >
              {({ pressed }) => (
                <ArrowLeft
                  size={16}
                  color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
              )}
            </Pressable>
          ) : null}
          {header.leading ? <View style={styles.headerLeadingSlot}>{header.leading}</View> : null}
          <Text style={styles.inlineTitle} numberOfLines={1}>
            {header.title}
          </Text>
          {header.actions ? <View style={styles.headerActions}>{header.actions}</View> : null}
        </View>
      ) : null}
      {header.search ? (
        <View style={styles.inlineSearchRow}>
          <Search size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          <AdaptiveTextInput
            // @ts-expect-error - outlineStyle is web-only
            style={SEARCH_INPUT_STYLE}
            placeholder={header.search.placeholder ?? t("common.actions.search")}
            resetKey={header.search.resetKey}
            onChangeText={header.search.onChange}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={header.search.autoFocus}
            testID={header.search.testID}
          />
        </View>
      ) : null}
    </View>
  );
}

export interface AdaptiveModalSheetProps {
  header: SheetHeader;
  visible: boolean;
  onClose: () => void;
  onDismiss?: () => void;
  children: ReactNode;
  /** Sticky footer rendered below the scrollable content. */
  footer?: ReactNode;
  snapPoints?: string[];
  testID?: string;
  /** Override the max width of the desktop card. */
  desktopMaxWidth?: number;
  /**
   * Desktop only: when false, the centered card renders without the dark
   * backdrop dim, and clicks fall through to the app behind it (the card stays
   * interactive; there is no click-outside-to-close — the user closes via the
   * X). Esc-to-close still works. Defaults to true (dimmed, click-outside).
   */
  desktopBackdrop?: boolean;
  scrollable?: boolean;
  presentation?: "push" | "replace";
  /**
   * Compact only: let the sheet grow to fit its content instead of snapping to
   * fixed points. It starts at content height and is capped at the safe-area
   * top (via `topInset`), scrolling internally once it hits the ceiling. Use for
   * short, variable-length lists where a fixed 55%/90% snap wastes space.
   */
  dynamicSizing?: boolean;
  /**
   * Compact only: size the content to the snap point currently in use rather
   * than to the tallest one, so a sheet opened at 55 % doesn't reserve the room
   * of the 90 % point. Ignored on desktop, where the sheet is a fixed panel.
   */
  sizeContentToCurrentSnapPoint?: boolean;
  /** Style applied to the sticky footer container. */
  footerContainerStyle?: StyleProp<ViewStyle>;
  /** Style applied to the sheet body that wraps the children. */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /**
   * Compact only: horizontal padding token for the bottom-sheet body. Defaults
   * to the shared header indent (spacing[4]); pass a smaller scale for dense
   * lists that should sit closer to the edges.
   */
  contentPaddingScale?: number;
  /**
   * Compact only: vertical padding token for the bottom-sheet body. Defaults to
   * spacing[3] on top and spacing[4] + safe area at the bottom. Pass `0` when
   * the content is a full-height pane that owns its own spacing — the bottom
   * then collapses to the safe-area inset alone instead of stacking an extra
   * indent under it.
   */
  contentVerticalPaddingScale?: number;
  /**
   * Compact only: extra space reserved above the sheet, stacked on the safe-area
   * top inset. gorhom measures its container as `screen - topInset`, so this
   * both lowers the sheet's ceiling and makes a `"100%"` snap point mean "every
   * pixel below that band". Pass the app header height when the sheet should
   * stop just under it (the task board drawers) instead of covering it.
   */
  compactTopInsetExtra?: number;
}

/**
 * Ceiling of the compact sheet: the safe-area top, plus whatever band the caller
 * wants left uncovered above it (the app header, for the task board drawers).
 */
function compactSheetTopInset(safeAreaTop: number, extra: number | undefined): number {
  return safeAreaTop + (extra ?? 0);
}

/**
 * Body/footer padding for the sheet: the caller's padding tokens merged with the
 * compact safe-area indent. The bottom indent grows from whatever vertical
 * padding the body uses, so a pane that opted out of the sheet's own spacing
 * (`contentVerticalPaddingScale={0}`) keeps nothing but the safe-area inset.
 */
function useSheetBodyStyles({
  isMobile,
  hasFooter,
  safeAreaBottom,
  spacing,
  contentPaddingScale,
  contentVerticalPaddingScale,
}: {
  isMobile: boolean;
  hasFooter: boolean;
  safeAreaBottom: number;
  spacing: Record<number, number>;
  contentPaddingScale?: number;
  contentVerticalPaddingScale?: number;
}) {
  const horizontal = contentPaddingScale != null ? spacing[contentPaddingScale] : null;
  const vertical =
    contentVerticalPaddingScale != null ? spacing[contentVerticalPaddingScale] : null;
  const safeArea = useMemo(
    () =>
      getCompactSheetSafeAreaPadding({
        isCompact: isMobile,
        hasFooter,
        baseContentPadding: vertical ?? spacing[SHEET_HORIZONTAL_PADDING_SCALE],
        baseFooterPadding: spacing[3],
        safeAreaBottom,
      }),
    [hasFooter, isMobile, safeAreaBottom, spacing, vertical],
  );
  const contentPadding = useMemo(
    () => [
      horizontal != null ? { paddingHorizontal: horizontal } : null,
      vertical != null ? { paddingVertical: vertical } : null,
      safeArea.contentPaddingBottom != null
        ? { paddingBottom: safeArea.contentPaddingBottom }
        : null,
    ],
    [horizontal, vertical, safeArea.contentPaddingBottom],
  );
  const footerPadding = useMemo(
    () =>
      safeArea.footerPaddingBottom != null ? { paddingBottom: safeArea.footerPaddingBottom } : null,
    [safeArea.footerPaddingBottom],
  );
  return {
    bottomSheetContentStyle: useMemo(
      () => [styles.bottomSheetContent, ...contentPadding],
      [contentPadding],
    ),
    bottomSheetStaticContentStyle: useMemo(
      () => [styles.bottomSheetStaticContent, ...contentPadding],
      [contentPadding],
    ),
    footerStyle: useMemo(() => [styles.footer, footerPadding], [footerPadding]),
    compactFooterStyle: useMemo(
      () => [styles.footer, styles.footerCompact, footerPadding],
      [footerPadding],
    ),
  };
}

export function AdaptiveModalSheet({
  header,
  visible,
  onClose,
  onDismiss,
  children,
  footer,
  snapPoints,
  testID,
  desktopMaxWidth,
  desktopBackdrop = true,
  scrollable = true,
  presentation,
  dynamicSizing = false,
  contentPaddingScale,
  contentVerticalPaddingScale,
  compactTopInsetExtra,
}: AdaptiveModalSheetProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const resolvedSnapPoints = useMemo(() => snapPoints ?? ["65%", "90%"], [snapPoints]);
  const {
    bottomSheetContentStyle,
    bottomSheetStaticContentStyle,
    footerStyle,
    compactFooterStyle,
  } = useSheetBodyStyles({
    isMobile,
    hasFooter: Boolean(footer),
    safeAreaBottom: insets.bottom,
    spacing: theme.spacing,
    contentPaddingScale,
    contentVerticalPaddingScale,
  });
  // Pinned footer for the compact scrollable sheet: BottomSheetFooter tracks
  // the sheet's animated position (and the keyboard), so the footer stays glued
  // to the visible bottom edge instead of drifting when the sheet extends.
  const renderCompactFooter = useCallback(
    (footerProps: BottomSheetFooterProps) => (
      <BottomSheetFooter {...footerProps}>
        <View style={compactFooterStyle}>{footer}</View>
      </BottomSheetFooter>
    ),
    [footer, compactFooterStyle],
  );
  const handleIndicatorStyle = useMemo(
    () => ({ backgroundColor: theme.colors.palette.zinc[600] }),
    [theme.colors.palette.zinc],
  );
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    isEnabled: isMobile,
    onClose,
  });
  const [shouldRenderWeb, setShouldRenderWeb] = useState(visible);
  const [isWebClosing, setIsWebClosing] = useState(false);
  const nativeModalDismissNotifiedRef = useRef(!visible);
  const handleDismiss = useCallback(() => {
    handleSheetDismiss();
    onDismiss?.();
  }, [handleSheetDismiss, onDismiss]);
  const notifyNativeModalDismiss = useCallback(() => {
    if (nativeModalDismissNotifiedRef.current) {
      return;
    }
    nativeModalDismissNotifiedRef.current = true;
    onDismiss?.();
  }, [onDismiss]);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.45} />
    ),
    [],
  );

  const desktopCardStyle = useMemo(
    () => [styles.desktopCard, desktopMaxWidth != null && { maxWidth: desktopMaxWidth }],
    [desktopMaxWidth],
  );
  const desktopOverlayStyle = useMemo(
    () => [
      desktopBackdrop ? styles.desktopOverlay : styles.desktopOverlayNoBackdrop,
      isWeb && {
        opacity: isWebClosing ? 0 : 1,
        transitionDuration: `${WEB_EXIT_DURATION_MS}ms`,
        transitionProperty: "opacity",
        transitionTimingFunction: "ease",
      },
    ],
    [isWebClosing, desktopBackdrop],
  );

  useEffect(() => {
    if (!isWeb || isMobile || !visible) return;
    return pushEscHandler(onClose);
  }, [visible, isMobile, onClose]);

  useEffect(() => {
    if (visible) {
      nativeModalDismissNotifiedRef.current = false;
    }
  }, [visible]);

  useEffect(() => {
    if (!isWeb || isMobile) return;
    if (visible) {
      setShouldRenderWeb(true);
      setIsWebClosing(false);
      return;
    }
    if (!shouldRenderWeb) return;
    setIsWebClosing(true);
    const timeout = window.setTimeout(() => {
      setShouldRenderWeb(false);
      setIsWebClosing(false);
      onDismiss?.();
    }, WEB_EXIT_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [visible, isMobile, onDismiss, shouldRenderWeb]);

  useEffect(() => {
    if (isWeb || isMobile || visible || Platform.OS !== "android") return;
    const timeout = setTimeout(notifyNativeModalDismiss, 0);
    return () => clearTimeout(timeout);
  }, [visible, isMobile, notifyNativeModalDismiss]);

  const compactHeader = <SheetHeaderView header={header} onClose={onClose} testID={testID} />;
  const compactStaticFooter =
    footer && !scrollable ? <View style={footerStyle}>{footer}</View> : null;

  if (isMobile) {
    let compactBody: ReactNode;
    if (dynamicSizing) {
      // Dynamic sizing must measure the true content height, so the body is a
      // gorhom BottomSheetView (which reports its natural size) rather than a
      // scroll view — a BottomSheetScrollView fills the available frame and the
      // sheet snaps taller than its content. The sheet is capped at `topInset`,
      // so short lists hug their content instead of wasting vertical space.
      //
      // Header and footer live INSIDE that view on purpose. gorhom derives the
      // sheet height from the BottomSheetView's layout alone, and renders that
      // view `position: absolute` — anything left as a sibling is both unmeasured
      // and drawn underneath, which is how a confirm dialog ended up one header
      // short with its title printed over its own message and its buttons cut
      // off past the screen edge.
      compactBody = (
        <BottomSheetView>
          {compactHeader}
          <View style={bottomSheetContentStyle}>{children}</View>
          {compactStaticFooter}
        </BottomSheetView>
      );
    } else if (scrollable) {
      // Padding lives on an inner View, NOT on contentContainerStyle:
      // BottomSheetScrollView is not a Unistyles-remapped component, so a
      // Unistyles style passed to contentContainerStyle is dropped on web
      // (docs/unistyles.md, "Main Gotcha: contentContainerStyle").
      compactBody = (
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          enableFooterMarginAdjustment={Boolean(footer)}
        >
          <View style={bottomSheetContentStyle}>{children}</View>
        </BottomSheetScrollView>
      );
    } else {
      compactBody = <View style={bottomSheetStaticContentStyle}>{children}</View>;
    }
    return (
      <IsolatedBottomSheetModal
        ref={sheetRef}
        snapPoints={dynamicSizing ? undefined : resolvedSnapPoints}
        index={0}
        enableDynamicSizing={dynamicSizing}
        onChange={handleSheetChange}
        onDismiss={handleDismiss}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundComponent={SheetBackground}
        handleIndicatorStyle={handleIndicatorStyle}
        // Cap the sheet at the safe-area top so `keyboardBehavior="extend"` stops
        // below the status bar instead of sliding the header under the notch/clock
        // when the keyboard opens. `compactTopInsetExtra` pushes that ceiling
        // further down (e.g. below the app header) for callers that ask for it.
        topInset={compactSheetTopInset(insets.top, compactTopInsetExtra)}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        accessible={false}
        presentation={presentation}
        footerComponent={footer && scrollable ? renderCompactFooter : undefined}
      >
        {dynamicSizing ? null : compactHeader}
        {compactBody}
        {dynamicSizing ? null : compactStaticFooter}
      </IsolatedBottomSheetModal>
    );
  }

  const cardInner = (
    <>
      <SheetHeaderView header={header} onClose={onClose} />
      {scrollable ? (
        <View style={styles.desktopScrollContainer}>
          <ScrollView
            style={styles.desktopScroll}
            contentContainerStyle={styles.desktopContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            {children}
          </ScrollView>
        </View>
      ) : (
        <View style={styles.desktopStaticContent}>{children}</View>
      )}
      {footer ? <View style={footerStyle}>{footer}</View> : null}
    </>
  );

  const desktopContent = (
    <View style={desktopOverlayStyle} testID={testID}>
      {desktopBackdrop ? (
        <Pressable
          accessibilityLabel={t("common.actions.dismiss")}
          style={ABSOLUTE_FILL_STYLE}
          onPress={onClose}
        />
      ) : null}
      <View style={desktopCardStyle}>{cardInner}</View>
    </View>
  );

  // On web, use portal to overlay root for consistent stacking with toasts
  if (isWeb && typeof document !== "undefined") {
    if (!shouldRenderWeb) return null;
    return createPortal(desktopContent, getOverlayRoot());
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
      onDismiss={notifyNativeModalDismiss}
      hardwareAccelerated
    >
      {desktopContent}
    </Modal>
  );
}
