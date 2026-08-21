/** @startingPoint section="Components" subtitle="Engraved mono button" viewport="700x170" */
export interface ButtonProps {
  variant?: 'outline' | 'solid' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}