"""
TinyRestorer: a small convolutional network that turns a blurry/noisy image into a
clean one. The training notebook (training/train_restorer.ipynb) contains this same code.

It uses residual learning: instead of drawing the whole clean image, the network
predicts only the *correction* (the missing detail and the noise to remove), which is
added to the input. That makes a tiny network train quickly and well.
"""
import torch
from torch import nn


class ResidualBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.body = nn.Sequential(
            nn.Conv2d(channels, channels, 3, padding=1),
            nn.ReLU(inplace=True),
            nn.Conv2d(channels, channels, 3, padding=1),
        )

    def forward(self, x):
        return x + self.body(x)


class TinyRestorer(nn.Module):
    def __init__(self, channels: int = 32, blocks: int = 6):
        super().__init__()
        self.head = nn.Conv2d(3, channels, 3, padding=1)            # pixels -> features
        self.body = nn.Sequential(*[ResidualBlock(channels) for _ in range(blocks)])
        self.tail = nn.Conv2d(channels, 3, 3, padding=1)            # features -> correction

    def forward(self, x):
        # x: images with values 0..1, shape (batch, 3, height, width)
        return x + self.tail(self.body(self.head(x)))
