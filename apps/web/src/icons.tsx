import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowsOutSimpleIcon,
  CameraIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  DownloadSimpleIcon,
  GearSixIcon,
  HardDrivesIcon,
  ImageIcon,
  ImagesIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  PlayIcon,
  PlusIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  StopIcon,
  TranslateIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningIcon,
  ArrowClockwiseIcon,
  type IconProps as PhosphorIconProps,
} from '@phosphor-icons/react';
import type { ComponentType } from 'react';

export type IconName =
  | 'add'
  | 'archive'
  | 'arrow-down'
  | 'arrow-up'
  | 'back'
  | 'camera'
  | 'check'
  | 'chevron-down'
  | 'clock'
  | 'copy'
  | 'download'
  | 'fit'
  | 'gear'
  | 'image'
  | 'language'
  | 'play'
  | 'queue'
  | 'refresh'
  | 'settings'
  | 'shield'
  | 'storage'
  | 'stop'
  | 'trash'
  | 'upload'
  | 'warning'
  | 'zoom-in'
  | 'zoom-out';

type IconProps = Omit<PhosphorIconProps, 'children' | 'weight'> & {
  name: IconName;
  weight?: PhosphorIconProps['weight'];
};

const icons: Record<IconName, ComponentType<PhosphorIconProps>> = {
  add: PlusIcon,
  archive: ArchiveIcon,
  'arrow-down': CaretDownIcon,
  'arrow-up': CaretUpIcon,
  back: ArrowLeftIcon,
  camera: CameraIcon,
  check: CheckIcon,
  'chevron-down': CaretDownIcon,
  clock: ClockCounterClockwiseIcon,
  copy: CopyIcon,
  download: DownloadSimpleIcon,
  fit: ArrowsOutSimpleIcon,
  gear: GearSixIcon,
  image: ImageIcon,
  language: TranslateIcon,
  play: PlayIcon,
  queue: ImagesIcon,
  refresh: ArrowClockwiseIcon,
  settings: SlidersHorizontalIcon,
  shield: ShieldCheckIcon,
  storage: HardDrivesIcon,
  stop: StopIcon,
  trash: TrashIcon,
  upload: UploadSimpleIcon,
  warning: WarningIcon,
  'zoom-in': MagnifyingGlassPlusIcon,
  'zoom-out': MagnifyingGlassMinusIcon,
};

export function Icon({ name, weight = 'regular', ...props }: IconProps) {
  const Glyph = icons[name];
  return (
    <Glyph
      aria-hidden
      focusable="false"
      weight={weight}
      {...props}
    />
  );
}
