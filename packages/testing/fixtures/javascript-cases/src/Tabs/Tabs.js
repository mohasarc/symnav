import React from "react";
import PropTypes from "prop-types";
import withStyles from "../styles/withStyles.js";

export const styles = {
  root: { display: "flex" },
};

class Tabs extends React.Component {
  state = { indicatorStyle: {} };

  componentDidMount() {
    this.updateIndicatorState();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.value !== this.props.value) {
      this.updateIndicatorState();
    }
  }

  updateIndicatorState() {
    this.setState({ indicatorStyle: { left: 0 } });
  }

  render() {
    const { classes, children } = this.props;
    return <div className={classes.root}>{children}</div>;
  }
}

Tabs.propTypes = {
  children: PropTypes.node,
  value: PropTypes.any,
};

export { Tabs };
export default withStyles(styles)(Tabs);
