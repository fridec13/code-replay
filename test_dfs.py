graph = {
    'A': ['B', 'C'],
    'B': ['D', 'E'],
    'C': ['F'],
    'D': [],
    'E': ['F'],
    'F': [],
}

def dfs(node, visited=None):
    if visited is None:
        visited = set()
    visited.add(node)
    result = [node]
    for neighbor in graph[node]:
        if neighbor not in visited:
            result += dfs(neighbor, visited)
    return result

def main():
    start = 'A'
    path = dfs(start)
    print("DFS path:", ' -> '.join(path))

main()
