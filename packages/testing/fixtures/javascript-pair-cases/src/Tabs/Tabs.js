import * as React from "react";
import withStyles from "../styles/withStyles";

export const styles = { root: { display: "flex" } };

const Tabs = React.forwardRef((props, ref) => {
  return <div ref={ref}>{props.children}</div>;
});

export default withStyles(styles, { name: "MuiTabs" })(Tabs);
