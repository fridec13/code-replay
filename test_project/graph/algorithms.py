"""Graph traversal algorithms: BFS and DFS."""

from collections import deque
from graph.node import Node


def bfs(start: Node) -> list[Node]:
    """Breadth-first search. Returns nodes in visit order."""
    visited: list[Node] = []
    queue: deque[Node] = deque([start])
    seen = {start}

    while queue:
        node = queue.popleft()
        visited.append(node)

        for neighbor in node.neighbors:
            if neighbor not in seen:
                seen.add(neighbor)
                queue.append(neighbor)

    return visited


def dfs(start: Node) -> list[Node]:
    """Depth-first search (iterative). Returns nodes in visit order."""
    visited: list[Node] = []
    stack: list[Node] = [start]
    seen = set()

    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        visited.append(node)

        for neighbor in reversed(node.neighbors):
            if neighbor not in seen:
                stack.append(neighbor)

    return visited


def find_path(start: Node, goal: Node) -> list[Node] | None:
    """BFS shortest path from start to goal. Returns node list or None."""
    if start is goal:
        return [start]

    prev: dict[Node, Node | None] = {start: None}
    queue: deque[Node] = deque([start])

    while queue:
        node = queue.popleft()
        if node is goal:
            path: list[Node] = []
            cur: Node | None = goal
            while cur is not None:
                path.append(cur)
                cur = prev[cur]
            path.reverse()
            return path

        for neighbor in node.neighbors:
            if neighbor not in prev:
                prev[neighbor] = node
                queue.append(neighbor)

    return None
