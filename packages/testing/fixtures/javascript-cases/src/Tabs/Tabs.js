import { formatLabel } from "../format.js";

export function createTabs(label) {
  return { label: formatLabel(label) };
}

export class Tabs {
  render() {
    return <div className="tabs">{this.props.label}</div>;
  }
}
