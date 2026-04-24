FROM nodejs/devcontainer:nightly

USER root

RUN apt update && apt install -y locales \
    && sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen

ENV LANG en_US.UTF-8  
ENV LANGUAGE en_US:en  
ENV LC_ALL en_US.UTF-8

RUN useradd --shell /bin/bash --create-home dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev \
    && chmod 0440 /etc/sudoers.d/dev

RUN apt update -y && apt install -y \
    iproute2 \
    net-tools \
    iputils-ping \
    vim \
    curl \
    git \
    sudo \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY ./script/setup-git.sh /usr/local/bin/setup-git.sh
RUN chmod +x /usr/local/bin/setup-git.sh

USER dev
WORKDIR /home/dev
ENV SHELL /bin/bash

RUN bash -c "$(curl -fsSL https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" --unattended