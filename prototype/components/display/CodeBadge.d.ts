export interface CodeBadgeProps {
  /** 1–2 character structure code, e.g. "VE" */
  code: string;
  selected?: boolean;
  size?: 'md' | 'lg';
}