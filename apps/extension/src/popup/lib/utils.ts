import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { withConcentric } from 'tailwindcss-concentric/merge';

const twMerge = extendTailwindMerge(withConcentric);

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
