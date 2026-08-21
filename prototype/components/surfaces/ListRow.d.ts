export interface ListRowProps {
  code: string;
  label: string;
  meta?: string;
  selected?: boolean;
  onClick?: () => void;
}