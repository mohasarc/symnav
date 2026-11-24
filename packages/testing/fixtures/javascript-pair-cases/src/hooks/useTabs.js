import Tabs from "../Tabs";
import TabsComponent from "../Tabs/Tabs";

export function useTabs() {
  return [Tabs({ value: 0 }), TabsComponent({ value: 0 })];
}
