import type { SVGProps } from 'react';

export type IconName =
  | 'add'
  | 'arrow-down'
  | 'arrow-up'
  | 'camera'
  | 'check'
  | 'clock'
  | 'image'
  | 'settings'
  | 'shield'
  | 'trash'
  | 'warning';

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
};

export function Icon({ name, ...props }: IconProps) {
  const commonProps: SVGProps<SVGSVGElement> = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...props,
  };

  switch (name) {
    case 'add':
      return (
        <svg {...commonProps}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'arrow-down':
      return (
        <svg {...commonProps}>
          <path d="m7 10 5 5 5-5" />
        </svg>
      );
    case 'arrow-up':
      return (
        <svg {...commonProps}>
          <path d="m7 14 5-5 5 5" />
        </svg>
      );
    case 'camera':
      return (
        <svg {...commonProps}>
          <path d="M4 7.5h3l1.3-2h7.4l1.3 2h3v11H4Z" />
          <circle cx="12" cy="13" r="3.2" />
        </svg>
      );
    case 'check':
      return (
        <svg {...commonProps}>
          <path d="m5 12 4 4L19 6" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case 'image':
      return (
        <svg {...commonProps}>
          <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
          <circle cx="9" cy="9" r="1.5" />
          <path d="m5.5 17 4.2-4.2 2.8 2.8 2.2-2.2 3.8 3.6" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="2.6" />
          <path d="M19 13.6v-3.2l-2-.7a7 7 0 0 0-.7-1.6l.9-1.9-2.3-2.3-1.9.9a7 7 0 0 0-1.6-.7l-.7-2H7.5l-.7 2a7 7 0 0 0-1.6.7l-1.9-.9L1 6.2l.9 1.9a7 7 0 0 0-.7 1.6l-2 .7v3.2l2 .7a7 7 0 0 0 .7 1.6L1 17.8l2.3 2.3 1.9-.9a7 7 0 0 0 1.6.7l.7 2h3.2l.7-2a7 7 0 0 0 1.6-.7l1.9.9 2.3-2.3-.9-1.9a7 7 0 0 0 .7-1.6l2-.7Z" transform="translate(2)" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...commonProps}>
          <path d="M12 3 5 6v5c0 4.7 2.8 8.1 7 10 4.2-1.9 7-5.3 7-10V6l-7-3Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case 'trash':
      return (
        <svg {...commonProps}>
          <path d="M5 7h14M9 7V4h6v3M7.5 7l.7 13h7.6l.7-13M10 11v5M14 11v5" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...commonProps}>
          <path d="M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4M12 16.5h.01" />
        </svg>
      );
  }
}
