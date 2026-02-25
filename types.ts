
export interface DetectedElement {
  name: string;
  type: 'character' | 'object' | 'background' | 'text' | 'mob' | 'ui' | 'logo';
}

export interface ThumbnailState {
  originalUrl: string | null;
  editedUrl: string | null;
  removedElementsUrl: string | null;
  replacementUrl: string | null;
  detectedElements: DetectedElement[];
  isAnalyzing: boolean;
  isEditing: boolean;
  error: string | null;
}

export enum EditMode {
  REMOVAL = 'removal',
  INSTRUCTION = 'instruction'
}
