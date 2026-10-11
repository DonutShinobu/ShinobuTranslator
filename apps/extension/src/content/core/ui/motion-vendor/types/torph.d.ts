interface SpringParams {
    stiffness?: number;
    damping?: number;
    mass?: number;
    precision?: number;
}

/** Numeric segments slide instead of fading, and digits and symbols slide opposite ways. */
type SegmentKind = "digit" | "symbol";
type Segment = {
    id: string;
    string: string;
    /** Absent for ordinary text. */
    kind?: SegmentKind;
};
interface BaseMorphOptions {
    element: HTMLElement;
    /** Ignored when `ease` is a spring, which settles on its own physics. */
    duration?: number;
    ease?: string | SpringParams;
    locale?: Intl.LocalesArgument;
    disabled?: boolean;
    respectReducedMotion?: boolean;
    onAnimationStart?: () => void;
    onAnimationComplete?: () => void;
}

interface TextMorphOptions extends BaseMorphOptions {
    debug?: boolean;
    scale?: boolean;
    /** Morph numeric words by place value. Off falls back to the character-level morph. */
    numbers?: boolean;
    /** Fraction digits for a numeric value. Ignored for strings. */
    decimals?: number;
    onAnimationCancel?: () => void;
}

declare class MorphController {
    private instance;
    private lastText;
    private lastCursorIndex?;
    private configKey;
    attach(element: HTMLElement, options: Omit<TextMorphOptions, "element">): void;
    update(text: string | number, cursorIndex?: number): void;
    needsRecreate(options: Omit<TextMorphOptions, "element">): boolean;
    destroy(): void;
    static serializeConfig(options: Omit<TextMorphOptions, "element">): string;
}

declare const DEFAULT_AS = "span";
declare const DEFAULT_TEXT_MORPH_OPTIONS: {
    readonly debug: false;
    readonly scale: true;
    readonly numbers: true;
    readonly locale: "en";
    readonly duration: 400;
    readonly ease: "cubic-bezier(0.19, 1, 0.22, 1)";
    readonly disabled: false;
    readonly respectReducedMotion: true;
};
declare class TextMorph {
    private element;
    private options;
    private data;
    private currentMeasures;
    private prevMeasures;
    private previousSegments;
    private isInitialRender;
    private reducedMotion;
    private srNode;
    private hasSetup;
    constructor(options: TextMorphOptions);
    /** Deferred, not done in the constructor: `prefers-reduced-motion` can change after it. */
    private setup;
    destroy(): void;
    private isDisabled;
    /** `cursorIndex` switches a single-number value from place matching to caret matching. */
    update(value: HTMLElement | string | number, cursorIndex?: number): void;
    private createTextGroup;
    private updateStyles;
    /** Holds the value as plain text — the segments are split and aria-hidden, so unreadable. */
    private syncAccessibleText;
}

declare function segmentText(value: string, locale: Intl.LocalesArgument, numbers?: boolean): Segment[];

type DiffResult = {
    segments: Segment[];
    splits: Map<string, Segment[]>;
};
type DiffOptions = {
    /** Numeric words morph by place value. Off falls back to character LCS. */
    numbers?: boolean;
    /** Caret position, honoured only when the value holds a single number. */
    cursorIndex?: number;
};
declare function diffSegments(oldSegments: Segment[], newText: string, locale: Intl.LocalesArgument, options?: DiffOptions): DiffResult;

type NumberSegment = Segment & {
    kind: SegmentKind;
};
/**
 * Whether a token is a quantity. Strict on purpose, and on by default: merely
 * containing a digit is not enough, or "COVID-19" and "2024-01-01" morph by place.
 */
declare function isNumericWord(word: string): boolean;
/** The locale's decimal separator — the pivot every alignment is measured from. */
declare function decimalSeparator(locale: Intl.LocalesArgument): string;
/** Per-character segments, matched by caret where `cursorIndex` is given, else by place. */
declare function segmentNumber(value: string, prevSegments?: NumberSegment[], cursorIndex?: number, decimalChar?: string): NumberSegment[];

export { DEFAULT_AS, DEFAULT_TEXT_MORPH_OPTIONS, type DiffOptions, type DiffResult, MorphController, type NumberSegment, type Segment, type SpringParams, TextMorph, type TextMorphOptions, decimalSeparator, diffSegments, isNumericWord, segmentNumber, segmentText };
