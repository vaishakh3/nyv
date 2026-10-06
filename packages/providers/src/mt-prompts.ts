import type { LanguageCode } from "@fyv/protocol";

/**
 * Per-target-language additions to the interpreter prompt, for languages where the models need
 * steering. Malayalam: every model tried wrote "almost" in a foreign script and misread spelled-out
 * numbers until shown digits and a few examples (bench, 2026-10). Hindi is deliberately unlisted.
 */
export const TARGET_NOTES: Partial<Record<LanguageCode, string>> = {
  ml:
    " Write numbers as digits (12, 340, 4:30). Write only in the Malayalam script.\n" +
    "Examples:\n" +
    '"The drop off is almost gone." → "ഡ്രോപ്പ്-ഓഫ് ഏകദേശം ഇല്ലാതായി."\n' +
    '"It took fifteen minutes." → "അതിന് 15 മിനിറ്റ് എടുത്തു."\n' +
    '"Great, that works." → "കൊള്ളാം, അത് മതി."',
};
