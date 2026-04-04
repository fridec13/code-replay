"""Graph node with adjacency list."""


class Node:
    def __init__(self, name: str):
        self.name = name
        self.neighbors: list["Node"] = []

    def connect(self, other: "Node") -> None:
        """Add a directed edge from self to other."""
        self.neighbors.append(other)

    def degree(self) -> int:
        """Number of outgoing edges."""
        return len(self.neighbors)

    def __repr__(self) -> str:
        return f"Node({self.name})"
