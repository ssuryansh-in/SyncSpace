declare module "fractional-indexing" {
  export function generateKeyBetween(
    a: string | null | undefined,
    b: string | null | undefined,
    digits?: string
  ): string;

  export function generateNKeysBetween(
    a: string | null | undefined,
    b: string | null | undefined,
    n: number,
    digits?: string
  ): string[];

  export const BASE_52_DIGITS: string;
  export const BASE_62_DIGITS: string;
}

