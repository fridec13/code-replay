"""Pretty-print helpers for graph results."""

from graph.node import Node


def print_graph(nodes: list[Node]) -> None:
    """Print adjacency list of all nodes."""
    print("-- Graph --")
    for node in nodes:
        neighbors = ", ".join(n.name for n in node.neighbors)
        arrow = f"-> [{neighbors}]" if neighbors else "-> (leaf)"
        print(f"  {node.name:>3}  {arrow}")
    print()


def print_traversal(label: str, nodes: list[Node]) -> None:
    """Print a traversal result as an arrow-separated path."""
    path = " -> ".join(n.name for n in nodes)
    print(f"{label:>4}: {path}")


def print_path(label: str, path: list[Node] | None) -> None:
    """Print a shortest-path result."""
    if path is None:
        print(f"{label}: No path found")
    else:
        steps = " -> ".join(n.name for n in path)
        print(f"{label}: {steps}  (len={len(path)})")
