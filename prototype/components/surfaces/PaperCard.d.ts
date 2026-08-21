export interface PaperCardProps {
  /** lighter top-face paper */
  raised?: boolean;
  /** light diagonal hatch fill */
  hatched?: boolean;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}