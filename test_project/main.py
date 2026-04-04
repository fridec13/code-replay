"""
Code Replay — multi-file test project.

Graph structure (directed):
        A
       / \\
      B   C
     /|    \\
    D  E    F
        \\
         G

Runs BFS, DFS, and shortest-path queries so execution jumps across:
  main.py  →  graph/node.py  →  graph/algorithms.py  →  utils/printer.py
"""

import sys
import os

# Make sure the project root is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from graph.node import Node
from graph.algorithms import bfs, dfs, find_path
from utils.printer import print_graph, print_traversal, print_path


def build_graph() -> list[Node]:
    """Create a 7-node directed graph and return all nodes."""
    a = Node("A")
    b = Node("B")
    c = Node("C")
    d = Node("D")
    e = Node("E")
    f = Node("F")
    g = Node("G")

    # Wire edges
    a.connect(b)
    a.connect(c)
    b.connect(d)
    b.connect(e)
    c.connect(f)
    e.connect(g)

    return [a, b, c, d, e, f, g]


def run_queries(nodes: list[Node]) -> None:
    """Run various graph queries and print the results."""
    root = nodes[0]          # A
    target = nodes[-1]       # G

    print_graph(nodes)

    bfs_order = bfs(root)
    print_traversal(" BFS", bfs_order)

    dfs_order = dfs(root)
    print_traversal(" DFS", dfs_order)

    path_ag = find_path(nodes[0], nodes[-1])   # A -> G
    print_path("A->G", path_ag)

    path_af = find_path(nodes[0], nodes[5])    # A -> F
    print_path("A->F", path_af)

    path_dg = find_path(nodes[3], nodes[-1])   # D -> G (unreachable from D)
    print_path("D->G", path_dg)


def main() -> None:
    print("=== Code Replay: Multi-file Graph Test ===\n")

    nodes = build_graph()
    run_queries(nodes)

    # Show node degrees
    print("\n-- Degrees --")
    for node in nodes:
        print(f"  {node.name}: degree = {node.degree()}")

    print("\nDone.")


if __name__ == "__main__":
    main()
