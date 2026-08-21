export interface StatCellProps {
  label: string;
  value: React.ReactNode;
  /** drop the right rule on the row's last cell */
  last?: boolean;
}