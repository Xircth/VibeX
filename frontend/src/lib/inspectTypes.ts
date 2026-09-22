export interface ComponentSource {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
}

export interface ComponentInfo {
  name: string;
  props: Record<string, unknown>;
  source: ComponentSource;
  pathToSource: string;
}

export interface SelectedComponent extends ComponentInfo {
  editor: string;
  url: string;
}

export interface ClickedElement {
  tag?: string;
  id?: string;
  className?: string;
  role?: string;
  dataset?: Record<string, string>;
}

export interface Coordinates {
  x?: number;
  y?: number;
}

export interface OpenInEditorPayload {
  selected: SelectedComponent;
  components: ComponentInfo[];
  trigger: 'alt-click' | 'context-menu' | 'tauri-inspector';
  coords?: Coordinates;
  clickedElement?: ClickedElement;
}
