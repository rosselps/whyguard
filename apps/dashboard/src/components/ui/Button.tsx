import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "success" | "danger" | "ghost";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-wg-brand-500 text-wg-text hover:bg-wg-brand-400",
  secondary: "border border-wg-border text-wg-text hover:bg-wg-surface-2",
  success: "bg-wg-success text-wg-canvas hover:brightness-110",
  danger: "bg-wg-danger text-wg-canvas hover:brightness-110",
  ghost: "text-wg-text-2 hover:text-wg-text",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  children: ReactNode;
};

/**
 * Button primitive with the 5 variants the UI spec defines. Callers are
 * responsible for the "max one Primary per block" and "Danger requires
 * explicit text, never icon-only" rules — this component only enforces that
 * `children` (text) is required, never optional, for every variant.
 */
export function Button({ variant = "secondary", className = "", children, ...rest }: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center gap-2 rounded-wg-md px-3 py-2 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wg-brand-400 ${VARIANT_CLASSES[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
